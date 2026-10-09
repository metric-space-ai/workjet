import type {
  CtoxDecisionHubProvisionInput,
  EnvironmentId,
  WorkjetConnectionSummary,
} from "@workjet/contracts";
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
