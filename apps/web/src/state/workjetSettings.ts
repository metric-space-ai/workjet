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
 * Coordinate the renderer's server-settings hydration. Cached ServerConfig is
 * available before the transport is live, so wait for readiness and remember
 * an environment only after the automatic selection persisted successfully.
 */
export function createAutomaticCurrentComputerHydrator(): (input: {
  readonly configuration: WorkjetConfiguration;
  readonly localEnvironmentId: EnvironmentId;
  readonly ready: boolean;
  readonly update: (configuration: WorkjetConfiguration) => Promise<boolean> | boolean;
}) => boolean {
  const hydratedEnvironmentIds = new Set<EnvironmentId>();
  const hydratingEnvironmentIds = new Set<EnvironmentId>();

  return (input) => {
    if (
      !input.ready ||
      hydratedEnvironmentIds.has(input.localEnvironmentId) ||
      hydratingEnvironmentIds.has(input.localEnvironmentId)
    ) {
      return false;
    }

    const next = applyAutomaticCurrentComputer(input.configuration, input.localEnvironmentId);
    if (next === input.configuration) {
      hydratedEnvironmentIds.add(input.localEnvironmentId);
      return false;
    }

    hydratingEnvironmentIds.add(input.localEnvironmentId);
    void Promise.resolve()
      .then(() => input.update(next))
      .then((persisted) => {
        if (persisted) {
          hydratedEnvironmentIds.add(input.localEnvironmentId);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        hydratingEnvironmentIds.delete(input.localEnvironmentId);
      });
    return true;
  };
}
