import type { WorkjetConfiguration } from "@workjet/contracts";

/** Public registry metadata only; execution paths and profile instructions stay private. */
export function computerInventory(configuration: {
  readonly computers: WorkjetConfiguration["computers"];
  readonly workerProfiles: ReadonlyArray<
    Pick<
      WorkjetConfiguration["workerProfiles"][number],
      "id" | "name" | "computerId" | "harness" | "role" | "capabilityIds"
    >
  >;
}) {
  return {
    schemaVersion: 1 as const,
    computers: configuration.computers.map((computer) => ({
      id: computer.id,
      label: computer.label,
      environmentId: computer.environmentId,
      presentationKind: computer.presentationKind,
      harnesses: computer.harnesses.map(({ harness, available }) => ({ harness, available })),
      profiles: configuration.workerProfiles
        .filter((profile) => profile.computerId === computer.id)
        .map(({ id, name, harness, role, capabilityIds }) => ({
          id,
          name,
          harness,
          role,
          capabilityIds,
        })),
    })),
  };
}
