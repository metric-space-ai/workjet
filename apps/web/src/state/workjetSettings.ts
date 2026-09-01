import type { EnvironmentId, WorkjetConfiguration } from "@t3tools/contracts";

/**
 * Fill the current-computer default without overriding an explicit operator
 * choice. The local server's computer wins even when remote computers are
 * already registered; the legacy single-computer fallback remains available
 * for profiles whose sole computer predates environment matching.
 */
export function applyAutomaticCurrentComputer(
  configuration: WorkjetConfiguration,
  localEnvironmentId: EnvironmentId | null,
): WorkjetConfiguration {
  if (configuration.selectedComputerId !== null) {
    return configuration;
  }

  const localComputer = configuration.computers.find(
    (computer) => computer.environmentId === localEnvironmentId,
  );
  const automaticComputer =
    localComputer ??
    (configuration.computers.length === 1 ? configuration.computers[0] : undefined);

  return automaticComputer === undefined
    ? configuration
    : { ...configuration, selectedComputerId: automaticComputer.id };
}

/**
 * Coordinate the renderer's server-settings hydration. Remember an
 * environment synchronously before persisting so repeated config projections
 * and React effect replays issue at most one update for that hydrated profile.
 */
export function createAutomaticCurrentComputerHydrator(): (input: {
  readonly configuration: WorkjetConfiguration;
  readonly localEnvironmentId: EnvironmentId;
  readonly update: (configuration: WorkjetConfiguration) => void;
}) => boolean {
  const hydratedEnvironmentIds = new Set<EnvironmentId>();

  return (input) => {
    if (hydratedEnvironmentIds.has(input.localEnvironmentId)) {
      return false;
    }
    hydratedEnvironmentIds.add(input.localEnvironmentId);

    const next = applyAutomaticCurrentComputer(input.configuration, input.localEnvironmentId);
    if (next === input.configuration) {
      return false;
    }
    input.update(next);
    return true;
  };
}
