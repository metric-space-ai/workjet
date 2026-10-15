import type { EnvironmentId, WorkjetComputer, WorkjetConfiguration } from "@workjet/contracts";
import {
  createWorkjetComputerDraft,
  saveWorkjetComputerDraft,
  type WorkjetEnvironmentTargetOption,
} from "./components/settings/WorkjetComputerEditor";

/** Host identity is presentation metadata; it never authorizes a connection or worker. */
export function findComputerForTarget(
  configuration: WorkjetConfiguration,
  target: WorkjetEnvironmentTargetOption,
  targets: ReadonlyArray<WorkjetEnvironmentTargetOption>,
): WorkjetComputer | undefined {
  const exact = configuration.computers.find(
    (computer) => computer.environmentId === target.environmentId,
  );
  if (exact) return exact;
  const hostId = target.hostId?.trim();
  if (!hostId) return undefined;
  return configuration.computers.find((computer) =>
    targets.some(
      (option) =>
        option.environmentId === computer.environmentId && option.hostId?.trim() === hostId,
    ),
  );
}

/** Settings and the composer use the same configured and saved coding connections. */
export function includeSavedComputers(
  configuration: WorkjetConfiguration,
  targets: ReadonlyArray<WorkjetEnvironmentTargetOption>,
  primaryEnvironmentId: EnvironmentId | null,
): WorkjetConfiguration {
  const computers = [...configuration.computers];
  const catalog = { ...configuration, computers };
  const primaryHostId = targets
    .find((target) => target.environmentId === primaryEnvironmentId)
    ?.hostId?.trim();
  for (const target of targets) {
    if (
      target.environmentId === primaryEnvironmentId ||
      (primaryHostId && target.hostId?.trim() === primaryHostId) ||
      findComputerForTarget(catalog, target, targets)
    )
      continue;
    computers.push(
      saveWorkjetComputerDraft(
        createWorkjetComputerDraft({
          environments: [target],
          id: `connection-${target.environmentId}`,
        }),
      ),
    );
  }
  return computers.length === configuration.computers.length ? configuration : catalog;
}
