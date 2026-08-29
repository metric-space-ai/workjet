// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The shared desktop link navigator (docs/workjet-plan.md "Cross-mode workflow
 * bridge", item 4): ONE entry point that turns an already-resolved cross-mode
 * target into "the right mode, the right sidebar entry, the right main
 * surface" — and never leaves both modes' heavy surfaces alive at once.
 *
 * ── Why the ordering is the whole point ─────────────────────────────────────
 * Business OS mode is not a React subtree. Its main surface is an Electron
 * `WebContentsView` owned by the main process (`CtoxGuestManager`), attached
 * OVER the renderer's window. Hiding `CtoxMainShell` does not detach it by
 * itself; `exitBusinessOsMode` does so while retaining the exact guest in the
 * warm pool. So a naive
 * "flip the setting and let React sort it out" paints the Code shell
 * UNDERNEATH a still-attached native view — both surfaces mounted, one of them
 * invisible to React and covering the other.
 *
 * The navigator therefore runs teardown-before-mount as an explicit,
 * observable sequence and records every step in an ordered JOURNAL, which is
 * what `crossModeNavigator.test.ts` asserts against:
 *
 *   business-os → code:  remember → release-business-os-surface (AWAITED,
 *                        the guest view is detached) → switch-product-mode →
 *                        select-sidebar-entry → open-main-surface
 *   code → business-os:  remember → release-code-surface (the thread view is
 *                        given up) → switch-product-mode → select-sidebar-entry
 *                        (this is what lets the guest be created at all) →
 *                        open-main-surface
 *
 * If the native teardown does not confirm, the mode is NOT switched: a failed
 * `exitBusinessOsMode` leaves the user in Business OS mode with a working
 * guest, which is strictly better than a Code shell hidden behind a live one.
 * `SidebarChromeHeader.handleProductModeChange` already had this rule for the
 * header toggle; the navigator is where it now lives for every caller.
 *
 * ── OS-delivered links versus in-app links ──────────────────────────────────
 * This function is the IN-APP path: a notification click, an "Open in Code"
 * action, a link clicked inside the renderer. The user's click IS the consent,
 * exactly as `DesktopWindow`'s `will-navigate` redirect argues for in-app
 * navigations, so there is no confirmation here.
 *
 * An OS-delivered `ctox-desktop://` link is the other case entirely — any page
 * or document on the machine can trigger one — and it never reaches this
 * function directly: `DesktopDeepLinkRouter` queues it and
 * `DeepLinkConfirmationDialog` asks the user first. Once confirmed, that link
 * resolves to a target and lands HERE. The confirmation gate stays where it
 * is; the navigator must never be wired as a second, silent entry point for
 * OS links.
 *
 * ── What this module deliberately does not do ───────────────────────────────
 * It does not mint, validate, or resolve links — the cross-mode link contract
 * and its RPCs are owned elsewhere (see `crossModeTarget.ts`). It receives a
 * bounded, already-validated target and moves the shell.
 */
import type { WorkjetProductMode } from "@t3tools/contracts/settings";

import {
  crossModeSelectionMemory as defaultSelectionMemory,
  resolveCrossModeSelection,
  type CrossModeSelectionMemory,
} from "./crossModeSelectionMemory";
import {
  crossModeModeForProductMode,
  decodeCrossModeTarget,
  normalizeCrossModeTarget,
  productModeForCrossModeMode,
  type CrossModeMode,
  type CrossModeTarget,
} from "./crossModeTarget";

/** The ordered vocabulary of navigation steps. The order here is the contract. */
export const CROSS_MODE_NAVIGATION_STEPS = [
  /** The outgoing mode's current selection is written to the memory. */
  "remember-source-selection",
  /** The CTOX guest `WebContentsView` is detached but retained warm. Awaited. */
  "release-business-os-surface",
  /** The Code thread view is given up before the guest may be created. */
  "release-code-surface",
  /** The persisted product mode is flipped; React swaps the shells. */
  "switch-product-mode",
  /** A bare target adopted the remembered selection for its mode. */
  "restore-remembered-selection",
  /** The owning mode's sidebar entry is selected. */
  "select-sidebar-entry",
  /** The main surface for that entry is opened. */
  "open-main-surface",
  /** The landing selection is written to the memory. */
  "remember-target-selection",
] as const;
export type CrossModeNavigationStep = (typeof CROSS_MODE_NAVIGATION_STEPS)[number];

export const CROSS_MODE_NAVIGATION_BLOCK_REASONS = [
  /** The value did not decode as a bounded target. */
  "invalid-target",
  /** Business OS mode cannot be hosted here (no Electron guest available). */
  "business-os-unavailable",
  /** The native guest teardown did not confirm; the mode was left alone. */
  "teardown-failed",
] as const;
export type CrossModeNavigationBlockReason = (typeof CROSS_MODE_NAVIGATION_BLOCK_REASONS)[number];

export interface CrossModeNavigationOutcome {
  readonly status: "navigated" | "blocked";
  readonly reason?: CrossModeNavigationBlockReason;
  /** The target actually acted on, after normalization and memory restore. */
  readonly target: CrossModeTarget | null;
  /** True when the product mode was flipped as part of this navigation. */
  readonly switchedMode: boolean;
  /** Every step, in the order it happened. The teardown-ordering evidence. */
  readonly steps: readonly CrossModeNavigationStep[];
}

export interface CrossModeNavigatorDependencies {
  /** The product mode showing right now. */
  readonly readProductMode: () => WorkjetProductMode;
  /** Flip the persisted product mode. Synchronous; React re-renders on it. */
  readonly setProductMode: (mode: WorkjetProductMode) => void;
  /**
   * Whether Business OS mode can be hosted at all. False outside Electron,
   * where `resolveWorkjetProductMode` already fails closed to Code.
   */
  readonly canHostBusinessOs: () => boolean;
  /**
   * Detach the CTOX guest `WebContentsView` without destroying its renderer or
   * peer. Resolves `true` only once Main confirms it no longer covers Workjet.
   */
  readonly releaseBusinessOsSurface: () => Promise<boolean>;
  /**
   * Give up the Code main surface (the thread view) before the guest may be
   * created. Synchronous: Code holds no native resource, so this is the
   * renderer relinquishing its claim, not an OS teardown.
   */
  readonly releaseCodeSurface: () => void;
  /** The live selection of a mode, used to fill the memory before leaving it. */
  readonly readCurrentSelection: (mode: CrossModeMode) => CrossModeTarget | null;
  /** Select the owning mode's sidebar entry (CTOX instance / Code environment). */
  readonly selectSidebarEntry: (target: CrossModeTarget) => void;
  /** Open the main surface for that entry (guest app / thread route). */
  readonly openMainSurface: (target: CrossModeTarget) => void;
  /** Defaults to the renderer-wide memory. Injected in tests. */
  readonly selectionMemory?: CrossModeSelectionMemory;
}

/**
 * Switch to the target's mode if needed, select its sidebar entry, and open
 * its main surface — detaching the other mode's painted surface FIRST.
 *
 * Accepts an unknown value so a target arriving over IPC or from a
 * notification is decoded (and stripped of excess keys) on the way in.
 */
export async function navigateToCrossModeTarget(
  rawTarget: unknown,
  dependencies: CrossModeNavigatorDependencies,
): Promise<CrossModeNavigationOutcome> {
  const steps: CrossModeNavigationStep[] = [];
  const record = (step: CrossModeNavigationStep) => {
    steps.push(step);
  };
  const memory = dependencies.selectionMemory ?? defaultSelectionMemory;

  const requested = decodeCrossModeTarget(rawTarget);
  if (requested === null) {
    return {
      status: "blocked",
      reason: "invalid-target",
      target: null,
      switchedMode: false,
      steps,
    };
  }

  const desiredProductMode = productModeForCrossModeMode(requested.mode);
  if (desiredProductMode === "ctox" && !dependencies.canHostBusinessOs()) {
    return {
      status: "blocked",
      reason: "business-os-unavailable",
      target: requested,
      switchedMode: false,
      steps,
    };
  }

  const currentProductMode = dependencies.readProductMode();
  const currentMode = crossModeModeForProductMode(currentProductMode);
  let switchedMode = false;

  if (currentProductMode !== desiredProductMode) {
    // 1. Remember where the user was BEFORE anything is torn down. The live
    //    selection is unreadable once the outgoing shell is gone.
    const leaving = dependencies.readCurrentSelection(currentMode);
    if (leaving !== null) {
      memory.remember(leaving);
      record("remember-source-selection");
    }

    // 2. Tear the outgoing mode's heavy surface down. Nothing below this line
    //    may run while the other surface is still alive.
    if (currentMode === "business-os") {
      const released = await dependencies.releaseBusinessOsSurface();
      record("release-business-os-surface");
      if (!released) {
        // The guest is still attached. Switching now would paint Code
        // underneath a live native view, so the navigation stops here and the
        // user keeps a working Business OS mode.
        return {
          status: "blocked",
          reason: "teardown-failed",
          target: requested,
          switchedMode: false,
          steps,
        };
      }
    } else {
      dependencies.releaseCodeSurface();
      record("release-code-surface");
    }

    // 3. Only now may the incoming shell mount.
    dependencies.setProductMode(desiredProductMode);
    record("switch-product-mode");
    switchedMode = true;
  }

  // 4. An addressed link wins; a bare one restores the remembered selection.
  const resolution = resolveCrossModeSelection(requested, memory.read(requested.mode));
  if (resolution.restored) record("restore-remembered-selection");
  const target = normalizeCrossModeTarget(resolution.target);

  // 5. Sidebar entry first, then the main surface: in Business OS mode the
  //    entry IS what causes the guest to be created, so opening a surface
  //    before selecting one has nothing to open into.
  dependencies.selectSidebarEntry(target);
  record("select-sidebar-entry");
  dependencies.openMainSurface(target);
  record("open-main-surface");

  memory.remember(target);
  record("remember-target-selection");

  return { status: "navigated", target, switchedMode, steps };
}

/**
 * Index of a step in an outcome's journal, or `-1`. A comparison helper for
 * the ordering assertions — `stepIndex(o, "release-business-os-surface") <
 * stepIndex(o, "switch-product-mode")` is the invariant this module exists for.
 */
export function crossModeStepIndex(
  outcome: CrossModeNavigationOutcome,
  step: CrossModeNavigationStep,
): number {
  return outcome.steps.indexOf(step);
}
