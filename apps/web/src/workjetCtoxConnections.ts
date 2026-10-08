import type { WorkjetConnectionSummary } from "@workjet/contracts";

/** Match a desktop catalog identity without changing the connection's native instance pin. */
export function ctoxConnectionMatchesSelectedInstance(
  connection: Pick<WorkjetConnectionSummary, "connectionId" | "instanceId" | "source">,
  selectedInstanceId: string | null,
  allowUnselected = false,
): boolean {
  if (selectedInstanceId === null) return allowUnselected;
  if (connection.instanceId === selectedInstanceId) return true;
  if (connection.source !== "ctox_dev" || !selectedInstanceId.startsWith("managed:")) return false;
  const tenantId = selectedInstanceId.slice("managed:".length);
  if (tenantId.length === 0) return false;
  const workerPrefix = `ctox-dev-worker-source:${tenantId}:`;
  return (
    connection.connectionId === `ctox-dev:${tenantId}` ||
    (connection.connectionId.startsWith(workerPrefix) &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        connection.connectionId.slice(workerPrefix.length),
      ))
  );
}
