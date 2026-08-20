// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The context-preserving half of the cross-mode switch (docs/workjet-plan.md
 * "Cross-mode workflow bridge", item 4: "context-preserving mode switch").
 *
 * Switching modes tears the outgoing mode's main surface down. Without a
 * memory, coming back lands on that mode's zero state and the user has to find
 * their place again. This store remembers exactly ONE selection per mode — the
 * last place the navigator left it — so a bare `{ mode: "code" }` link, or the
 * header's mode toggle, restores the previous selection instead.
 *
 * Bounded and redaction-clean by construction: what is remembered is a
 * {@link CrossModeTarget}, i.e. addresses only. No record data, no thread
 * content, no titles fetched from either authority. Two slots, no history, no
 * growth.
 */
import {
  isAddressedCrossModeTarget,
  normalizeCrossModeTarget,
  type CrossModeMode,
  type CrossModeTarget,
} from "./crossModeTarget";

export interface CrossModeSelectionMemory {
  /** The last selection recorded for `mode`, or `null` if there is none. */
  readonly read: (mode: CrossModeMode) => CrossModeTarget | null;
  /**
   * Record a selection. An UNADDRESSED target (a bare mode with no entry) is
   * ignored rather than stored: forgetting where the user was is worse than
   * remembering a slightly stale place, and a bare target carries nothing to
   * restore anyway.
   */
  readonly remember: (target: CrossModeTarget) => void;
  /** Drop a mode's memory — used when its entry is revoked or deleted. */
  readonly forget: (mode: CrossModeMode) => void;
}

export function createCrossModeSelectionMemory(): CrossModeSelectionMemory {
  const slots = new Map<CrossModeMode, CrossModeTarget>();
  return {
    read: (mode) => slots.get(mode) ?? null,
    remember: (target) => {
      const normalized = normalizeCrossModeTarget(target);
      if (!isAddressedCrossModeTarget(normalized)) return;
      slots.set(normalized.mode, normalized);
    },
    forget: (mode) => {
      slots.delete(mode);
    },
  };
}

/**
 * The renderer's single memory. Module-level on purpose: the memory has to
 * outlive both mode shells, and each shell is unmounted precisely when the
 * other one is showing.
 */
export const crossModeSelectionMemory: CrossModeSelectionMemory = createCrossModeSelectionMemory();

export interface CrossModeSelectionResolution {
  readonly target: CrossModeTarget;
  /** True when the remembered selection supplied the entry, not the link. */
  readonly restored: boolean;
}

/**
 * Resolve what to actually select: an addressed link always wins, and a bare
 * link falls back to the remembered selection for its mode.
 */
export function resolveCrossModeSelection(
  target: CrossModeTarget,
  remembered: CrossModeTarget | null,
): CrossModeSelectionResolution {
  const normalized = normalizeCrossModeTarget(target);
  if (isAddressedCrossModeTarget(normalized)) return { target: normalized, restored: false };
  if (remembered === null || remembered.mode !== normalized.mode) {
    return { target: normalized, restored: false };
  }
  return { target: normalizeCrossModeTarget(remembered), restored: true };
}
