import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import {
  type BusinessOsCodeScopeSnapshot,
  useBusinessOsCodeScope,
} from "../../businessOsCodeScope";
import {
  type EnvironmentPresentation,
  useBusinessOsScopedEnvironments,
} from "../../state/environments";

export type ActiveBusinessOsSettingsEnvironment =
  | { readonly phase: "resolving"; readonly environment: null; readonly reason: null }
  | {
      readonly phase: "blocked";
      readonly environment: null;
      readonly reason:
        | "no-active-instance"
        | "authority-unavailable"
        | "no-code-computer"
        | "ambiguous-code-computer";
    }
  | {
      readonly phase: "ready";
      readonly environment: EnvironmentPresentation;
      readonly reason: null;
    };

/**
 * Selects the only server that may currently own instance-scoped settings.
 *
 * Workjet's legacy settings are persisted per Code environment. Until the
 * CTOX-native instance configuration collection replaces that storage, more
 * than one assigned Code computer is ambiguous. Falling back to the primary,
 * the first environment, or the previously selected environment would expose
 * and mutate another Business OS instance, so every ambiguous state is
 * deliberately blocked.
 */
export function resolveActiveBusinessOsSettingsEnvironment(input: {
  readonly scope: BusinessOsCodeScopeSnapshot;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly inventoryReady: boolean;
}): ActiveBusinessOsSettingsEnvironment {
  if (input.scope.phase === "resolving" || !input.inventoryReady) {
    return { phase: "resolving", environment: null, reason: null };
  }
  if (input.scope.phase === "blocked") {
    return {
      phase: "blocked",
      environment: null,
      reason:
        input.scope.blocker === "no-active-instance"
          ? "no-active-instance"
          : "authority-unavailable",
    };
  }
  if (input.environments.length === 0) {
    return { phase: "blocked", environment: null, reason: "no-code-computer" };
  }
  if (input.environments.length !== 1) {
    return { phase: "blocked", environment: null, reason: "ambiguous-code-computer" };
  }
  const environment = input.environments[0];
  if (environment === undefined) {
    return { phase: "blocked", environment: null, reason: "no-code-computer" };
  }
  return { phase: "ready", environment, reason: null };
}

export function useActiveBusinessOsSettingsEnvironment(): ActiveBusinessOsSettingsEnvironment {
  const scope = useBusinessOsCodeScope();
  const { environments, isReady } = useBusinessOsScopedEnvironments();
  return useMemo(
    () =>
      resolveActiveBusinessOsSettingsEnvironment({
        scope,
        environments,
        inventoryReady: isReady,
      }),
    [environments, isReady, scope],
  );
}

export function activeBusinessOsSettingsEnvironmentId(
  target: ActiveBusinessOsSettingsEnvironment,
): EnvironmentId | null {
  return target.phase === "ready" ? target.environment.environmentId : null;
}
