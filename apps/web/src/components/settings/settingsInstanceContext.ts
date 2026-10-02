import type { CtoxDiscoveryResult } from "@workjet/contracts";
import { ctoxInstanceDisplayTitle } from "../ctox/ctoxInstanceDisplayTitle";

/** Discovery never supplies a default selection: a stale selection stays unselected. */
export function resolveSettingsInstanceContext(
  discovery: "loading" | CtoxDiscoveryResult,
  selectedId: string | null,
) {
  const instances =
    discovery !== "loading" && discovery._tag === "ready" ? discovery.instances : [];
  const instanceCount = new Set(instances.map((instance) => instance.id)).size;
  const active = instances.find((instance) => instance.id === selectedId);
  return {
    instanceCount,
    isMultiInstance: instanceCount > 1,
    hasActiveInstance: active !== undefined,
    activeInstanceName: active === undefined ? null : ctoxInstanceDisplayTitle(active),
  };
}
