import type {
  ComputerConnection,
  ComputerMetadata,
  WorkjetComputer,
  WorkjetConfiguration,
} from "@workjet/contracts";
export function defaultComputerMetadata(connection: ComputerConnection | null): ComputerMetadata {
  return {
    connection,
    facts: null,
    roles: { build: true, storage: false },
    active: true,
    hostKeyFingerprint: null,
    identityFiles: [],
    status: "unverified",
    error: null,
    previousIds: [],
    legacyRecords: [],
  };
}
export function migrateComputerRecords(configuration: WorkjetConfiguration): WorkjetConfiguration {
  return {
    ...configuration,
    computers: configuration.computers.map((computer) =>
      computer.metadata
        ? computer
        : {
            ...computer,
            metadata: {
              ...defaultComputerMetadata(
                computer.presentationKind === "local" ? { _tag: "local" } : null,
              ),
              legacyRecords: [computer],
            },
          },
    ),
  };
}
export function sameComputer(left: WorkjetComputer, right: WorkjetComputer): boolean {
  if (left.id === right.id || left.environmentId === right.environmentId) return true;
  const a = left.metadata,
    b = right.metadata;
  if (a?.facts?.machineId && b?.facts?.machineId) return a.facts.machineId === b.facts.machineId;
  return !!(a && b && a.hostKeyFingerprint && a.hostKeyFingerprint === b.hostKeyFingerprint);
}
/** Merge physical identity, preserve all legacy public data and remap every reference. */
export function reconcileComputer(
  configuration: WorkjetConfiguration,
  incoming: WorkjetComputer,
): WorkjetConfiguration {
  const matches = configuration.computers.filter((row) => sameComputer(row, incoming));
  const canonical = matches.find((row) => row.id === incoming.id) ?? matches[0] ?? incoming;
  const metadata = incoming.metadata ?? canonical.metadata;
  if (!metadata) throw new Error("Detected computer metadata required");
  const ids = new Set(matches.map((row) => row.id));
  ids.add(incoming.id);
  const previousIds = [
    ...new Set([
      ...metadata.previousIds,
      ...matches.flatMap((row) => row.metadata?.previousIds ?? []),
      ...ids,
    ]),
  ].filter((id) => id !== canonical.id);
  const merged: WorkjetComputer = {
    ...canonical,
    ...incoming,
    id: canonical.id,
    harnesses: [
      ...new Map(
        [...matches.flatMap((row) => row.harnesses), ...incoming.harnesses].map((row) => [
          row.harness,
          row,
        ]),
      ).values(),
    ],
    metadata: {
      ...metadata,
      facts: metadata.facts ?? canonical.metadata?.facts ?? null,
      hostKeyFingerprint:
        metadata.hostKeyFingerprint ?? canonical.metadata?.hostKeyFingerprint ?? null,
      identityFiles: metadata.identityFiles.length
        ? metadata.identityFiles
        : (canonical.metadata?.identityFiles ?? []),
      active: matches.some((row) => row.metadata?.active === false) ? false : metadata.active,
      roles: (matches.length === 1 ? matches[0]?.metadata?.roles : undefined) ?? {
        build: canonical.metadata?.roles.build ?? metadata.roles.build,
        storage: matches.some((row) => row.metadata?.roles.storage) || metadata.roles.storage,
      },
      previousIds,
      legacyRecords: [
        ...new Map(
          [
            ...metadata.legacyRecords,
            ...matches.flatMap((row) => row.metadata?.legacyRecords ?? []),
            ...matches.filter((row) => row.id !== canonical.id).map((row) => row),
          ].map((row) => [JSON.stringify(row), row] as const),
        ).values(),
      ],
    },
  };
  return {
    ...configuration,
    computers: [...configuration.computers.filter((row) => !ids.has(row.id)), merged],
    selectedComputerId:
      configuration.selectedComputerId && ids.has(configuration.selectedComputerId)
        ? merged.id
        : configuration.selectedComputerId,
    workerProfiles: configuration.workerProfiles.map((row) =>
      ids.has(row.computerId) ? { ...row, computerId: merged.id } : row,
    ),
  };
}
export function computerJobAllowed(
  computer: Pick<WorkjetComputer, "metadata">,
  job: "worker" | "build" | "storage",
): boolean {
  if (computer.metadata?.active === false) return false;
  if (job === "worker") return true;
  return job === "build"
    ? computer.metadata?.roles.build !== false
    : computer.metadata?.roles.storage === true;
}
