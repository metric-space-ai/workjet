import type { ProviderInstanceId } from "@workjet/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";

/** Keep the active profile, otherwise prefer an enabled default of the same driver. */
export function resolveManualHarnessInstances(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  selectedInstanceId: ProviderInstanceId,
  lockedDriver: string | null,
): ReadonlyMap<string, ProviderInstanceId> {
  const targets = new Map<string, ProviderInstanceId>();
  for (const entry of entries) {
    if (!entry.enabled || !entry.isAvailable) continue;
    if (lockedDriver !== null && entry.driverKind !== lockedDriver) continue;
    const current = targets.get(entry.driverKind);
    if (
      current === undefined ||
      entry.instanceId === selectedInstanceId ||
      (entry.isDefault && current !== selectedInstanceId)
    ) {
      targets.set(entry.driverKind, entry.instanceId);
    }
  }
  return targets;
}
