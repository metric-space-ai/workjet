import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useCtoxMetrics } from "./hooks";
import { getWorkjetKernelMount, subscribeWorkjetKernelMounts } from "./kernelClient";
import type { Metrics } from "./kernel/index";

/** Namespace generations are kernel facts. Missing telemetry is unknown, never green. */
export function collectionLiveness(metrics: Metrics | null, names: readonly string[]) {
  const collections = metrics?.collections ?? {};
  const requested = Object.fromEntries(
    names.map((name) => [
      name,
      Object.entries(collections)
        .filter(([key]) => key === name || key.startsWith(`${name}@g`))
        .map(([key, value]) => ({ key, ...value })),
    ]),
  );
  return {
    collections,
    requested,
    allLive:
      names.length > 0 &&
      Object.values(requested).every(
        (entries) => entries.length > 0 && entries.every((entry) => entry.state === "live"),
      ),
  };
}
export function useCtoxCollectionLiveness(instanceId: string | null, names: readonly string[]) {
  const metrics = useCtoxMetrics(instanceId);
  const readMount = useCallback(() => getWorkjetKernelMount(instanceId), [instanceId]);
  const mount = useSyncExternalStore(subscribeWorkjetKernelMounts, readMount, readMount);
  const key = JSON.stringify(names);
  const state = useMemo(() => collectionLiveness(metrics, JSON.parse(key)), [key, metrics]);
  const reconnect = useCallback(async () => {
    if (!mount || getWorkjetKernelMount(instanceId) !== mount)
      throw new Error("ctox_client_unavailable");
    return mount.kernel.reconnect();
  }, [instanceId, mount]);
  return {
    ...state,
    deviceId: mount?.kernel.identity.device_id ?? null,
    reconnect,
    canReconnect: mount !== null,
  };
}
