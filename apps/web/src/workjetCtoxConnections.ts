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
  return tenantId.length > 0 && connection.connectionId === `ctox-dev:${tenantId}`;
}
