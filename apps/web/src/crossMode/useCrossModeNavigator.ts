// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Production wiring for {@link navigateToCrossModeTarget}.
 *
 * The navigator itself is pure and dependency-injected so its ordering can be
 * asserted without a renderer; this module is the one place that binds those
 * dependencies to the real shell: the persisted product mode, the CTOX guest
 * bridge, the TanStack router, and the Business OS handoff slot.
 *
 * Keeping the two apart is not ceremony. The invariant that matters — the
 * native guest view is detached before Code paints while its peer stays warm — is only checkable if the
 * sequence is observable, and it is only observable if the sequence is not
 * tangled up in React effects.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { isElectron } from "../env";
import {
  businessOsCodeScopeContainsEnvironment,
  readBusinessOsCodeScope,
} from "../businessOsCodeScope";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { readActiveEnvironmentId, setActiveEnvironmentId } from "../state/entities";
import { resolveWorkjetProductMode } from "../workjetProductMode";
import { readActiveWorkjetScope } from "../activeWorkjetScope";
import {
  clearCrossModeBusinessOsRequest,
  peekCrossModeBusinessOsRequest,
  requestCrossModeBusinessOsApp,
  requestCrossModeBusinessOsInstance,
} from "./crossModeBusinessOsHandoff";
import {
  navigateToCrossModeTarget,
  type CrossModeNavigationOutcome,
  type CrossModeNavigatorDependencies,
} from "./crossModeNavigator";
import type { CrossModeMode, CrossModeTarget } from "./crossModeTarget";

/**
 * Read the Code selection currently on screen. The route is authoritative:
 * `/$environmentId/$threadId` is the only place Code records where the user
 * is, and it survives a trip through Business OS mode untouched.
 */
export function readCodeSelectionFromRouteParams(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
  fallbackEnvironmentId: string | null,
): CrossModeTarget | null {
  if (params.environmentId && params.threadId) {
    return { mode: "code", environmentId: params.environmentId, threadId: params.threadId };
  }
  if (fallbackEnvironmentId === null) return null;
  return { mode: "code", environmentId: fallbackEnvironmentId };
}

/**
 * The single cross-mode entry point for the renderer. Returns the navigation
 * outcome, including the step journal, so a caller can react to a blocked
 * teardown instead of assuming the switch happened.
 */
export function useCrossModeNavigator(): (target: unknown) => Promise<CrossModeNavigationOutcome> {
  const router = useRouter();
  const configuredProductMode = useClientSettings((settings) => settings.workjetProductMode);
  const updateClientSettings = useUpdateClientSettings();

  return useCallback(
    (target: unknown) => {
      const dependencies: CrossModeNavigatorDependencies = {
        readProductMode: () =>
          resolveWorkjetProductMode({ configuredMode: configuredProductMode, isElectron }),
        setProductMode: (mode) => {
          updateClientSettings({ workjetProductMode: mode });
        },
        canHostBusinessOs: () =>
          isElectron && typeof window !== "undefined" && window.desktopBridge?.ctox !== undefined,
        releaseBusinessOsSurface: async () => {
          const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.ctox;
          // No bridge means no guest was ever attached, so there is nothing to
          // detach and the switch is safe. A bridge that throws is treated as
          // an unconfirmed detachment: we do not know the view is gone.
          if (bridge === undefined) return true;
          try {
            const result = await bridge.exitBusinessOsMode();
            return result._tag === "completed";
          } catch {
            return false;
          }
        },
        releaseCodeSurface: () => {
          // Code holds no native surface — `AppSidebarLayout` unmounts the
          // thread view in the same commit that mounts the Business OS shell.
          // What this step does enforce is that no guest may be requested
          // while Code is still up: any request left over from an earlier,
          // abandoned switch is dropped here, so the only request the shell
          // can ever honour is the one filed after this point.
          clearCrossModeBusinessOsRequest();
        },
        readCurrentSelection: (mode: CrossModeMode) => {
          if (mode === "code") {
            const params = (router.state.matches.at(-1)?.params ?? {}) as Partial<
              Record<"environmentId" | "threadId", string | undefined>
            >;
            return readCodeSelectionFromRouteParams(params, readActiveEnvironmentId());
          }
          const selectedInstanceId = readActiveWorkjetScope().selectedInstanceId;
          return selectedInstanceId === null
            ? null
            : { mode: "business-os", ctoxInstanceId: selectedInstanceId };
        },
        selectSidebarEntry: (resolved) => {
          if (resolved.mode === "business-os") {
            requestCrossModeBusinessOsInstance(resolved);
            return;
          }
          if (resolved.environmentId === undefined) return;
          const environmentId = resolved.environmentId as EnvironmentId;
          if (!businessOsCodeScopeContainsEnvironment(readBusinessOsCodeScope(), environmentId)) {
            return;
          }
          setActiveEnvironmentId(environmentId);
        },
        openMainSurface: (resolved) => {
          if (resolved.mode === "business-os") {
            requestCrossModeBusinessOsApp(resolved);
            return;
          }
          if (resolved.environmentId === undefined || resolved.threadId === undefined) return;
          const environmentId = resolved.environmentId as EnvironmentId;
          if (!businessOsCodeScopeContainsEnvironment(readBusinessOsCodeScope(), environmentId)) {
            return;
          }
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: {
              environmentId,
              threadId: resolved.threadId as ThreadId,
            },
          });
        },
      };
      return navigateToCrossModeTarget(target, dependencies);
    },
    [configuredProductMode, router, updateClientSettings],
  );
}

/** Re-exported so callers do not have to reach into the handoff module. */
export { peekCrossModeBusinessOsRequest };
