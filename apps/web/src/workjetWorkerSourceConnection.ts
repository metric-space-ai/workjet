import type {
  CtoxDecisionHubProvisionInput,
  EnvironmentId,
  WorkjetConnectionSummary,
  WorkjetThreadConfig,
} from "@workjet/contracts";
import { normalizeWorkjetThreadConfig } from "@workjet/contracts";
import { ctoxConnectionMatchesSelectedInstance } from "./workjetCtoxConnections";

export function workerSourceProvisionRequest(
  environmentId: EnvironmentId,
  selectedInstanceId: string | null,
): CtoxDecisionHubProvisionInput | null {
  if (!selectedInstanceId?.startsWith("managed:")) return null;
  const tenantId = selectedInstanceId.slice("managed:".length);
  if (tenantId.length === 0) return null;
  return { environmentId, purpose: "worker_source", target: { _tag: "ctox_dev", tenantId } };
}

export function workerSourceConnectionForInstance(
  connections: readonly WorkjetConnectionSummary[],
  selectedInstanceId: string | null,
): WorkjetConnectionSummary | undefined {
  if (!selectedInstanceId?.startsWith("managed:")) return undefined;
  const prefix = `ctox-dev-worker-source:${selectedInstanceId.slice("managed:".length)}:`;
  const matching = connections.filter(
    (connection) =>
      connection.connectionId.startsWith(prefix) &&
      ctoxConnectionMatchesSelectedInstance(connection, selectedInstanceId),
  );
  return matching.find((connection) => connection.status === "ready") ?? matching[0];
}

export function workerSourceIsBound(
  config: WorkjetThreadConfig,
  connection: WorkjetConnectionSummary,
): boolean {
  const normalized = normalizeWorkjetThreadConfig(config);
  return (
    connection.status === "ready" &&
    normalized.enabledCapabilityIds.includes("ctox-business-os") &&
    normalized.capabilityBindings.some(
      (binding) =>
        binding.capabilityId === "ctox-business-os" &&
        binding.target.connectionId === connection.connectionId &&
        binding.target.instanceId === connection.instanceId,
    )
  );
}

/** Save source authority while retaining durable turn state and other capabilities. */
export function withWorkerSourceConnection(
  config: WorkjetThreadConfig,
  selectedInstanceId: string | null,
  connection: WorkjetConnectionSummary,
): WorkjetThreadConfig | null {
  if (
    connection.status !== "ready" ||
    !workerSourceConnectionForInstance([connection], selectedInstanceId)
  )
    return null;
  const normalized = normalizeWorkjetThreadConfig(config);
  return {
    ...normalized,
    schemaVersion: 2,
    enabledCapabilityIds: normalized.enabledCapabilityIds.includes("ctox-business-os")
      ? normalized.enabledCapabilityIds
      : [...normalized.enabledCapabilityIds, "ctox-business-os"],
    capabilityBindings: [
      ...normalized.capabilityBindings.filter(
        (binding) => binding.capabilityId !== "ctox-business-os",
      ),
      {
        capabilityId: "ctox-business-os",
        target: {
          kind: "ctox-connection",
          connectionId: connection.connectionId,
          instanceId: connection.instanceId,
        },
      },
    ],
  };
}
