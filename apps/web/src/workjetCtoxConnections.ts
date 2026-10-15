import type { WorkjetConnectionSummary } from "@workjet/contracts";

/** An explicit source binding wins without widening the selected instance's authority. */
export function lumaConnectionForInstance(
  connections: readonly WorkjetConnectionSummary[],
  selectedInstanceId: string | null,
  boundSource?: { readonly connectionId: string; readonly instanceId?: string },
): WorkjetConnectionSummary | undefined {
  const ready = connections.filter(
    (connection) =>
      connection.status === "ready" &&
      ctoxConnectionMatchesSelectedInstance(connection, selectedInstanceId),
  );
  if (boundSource !== undefined)
    return ready.find(
      (connection) =>
        connection.connectionId === boundSource.connectionId &&
        connection.instanceId === boundSource.instanceId,
    );
  return ready.length === 1
    ? ready[0]
    : ready.find(
        (connection) =>
          connection.connectionId === `ctox-dev:${selectedInstanceId?.replace(/^managed:/, "")}`,
      );
}

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
