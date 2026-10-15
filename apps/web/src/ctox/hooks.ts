import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  getCtoxClient,
  subscribeCtoxClients,
  type CommandHandle,
  type CtoxAppApi,
  type Query,
} from "./ctoxClient";
import { createLiveStore } from "./liveStore";

const EMPTY_ROWS: never[] = [];
const emptyRows = () => EMPTY_ROWS;
const emptyDoc = () => null;
const noSubscription = () => () => {};

/** Distinguish regex from JSON objects with regex-like fields, and preserve array/sort order. */
function queryKey(value: unknown): string {
  if (value instanceof RegExp) return `regexp:${JSON.stringify([value.source, value.flags])}`;
  if (Array.isArray(value)) return `array:[${value.map(queryKey).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `object:{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${queryKey(item)}`)
      .join(",")}}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}

export function useCtoxClient(instanceId: string | null): CtoxAppApi | null {
  const read = useCallback(() => getCtoxClient(instanceId), [instanceId]);
  return useSyncExternalStore(subscribeCtoxClients, read, read);
}

/** Queries are synchronous local reads, independent of link state and backlog. */
export function useCtoxQuery<T>(instanceId: string | null, collection: string, query: Query): T[] {
  const api = useCtoxClient(instanceId);
  // RegExp is part of Mango; preserve its source/flags in the memoization key.
  const key = queryKey(query);
  const store = useMemo(
    () => (api === null ? null : createLiveStore(api.query<T>(collection, query))),
    // The serialized query also supports inline object arguments without resubscribing each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, collection, key],
  );
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? emptyRows,
    store?.getSnapshot ?? emptyRows,
  );
}

export function useCtoxDoc<T>(
  instanceId: string | null,
  collection: string,
  id: string | null,
): T | null {
  const api = useCtoxClient(instanceId);
  const store = useMemo(
    () => (api === null || id === null ? null : createLiveStore(api.get<T>(collection, id))),
    [api, collection, id],
  );
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? emptyDoc,
    store?.getSnapshot ?? emptyDoc,
  );
}

export function useCtoxMetrics(instanceId: string | null) {
  const api = useCtoxClient(instanceId);
  const store = useMemo(() => (api === null ? null : createLiveStore(api.metrics)), [api]);
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? emptyDoc,
    store?.getSnapshot ?? emptyDoc,
  );
}

/** Unmount detaches status; it does not cancel a durable command. Cancellation stays explicit. */
export function useCtoxCommand(instanceId: string | null) {
  const api = useCtoxClient(instanceId);
  const scope = useMemo(() => ({ active: true }), [api, instanceId]);
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);
  const [current, setCurrent] = useState<{ api: CtoxAppApi; handle: CommandHandle } | null>(null);
  const handle = current?.api === api ? current.handle : null;
  const store = useMemo(() => (handle === null ? null : createLiveStore(handle.status)), [handle]);
  const status = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? emptyDoc,
    store?.getSnapshot ?? emptyDoc,
  );
  const command = useCallback(
    (type: string, payload: object, options?: { record_id?: string }): CommandHandle => {
      if (!scope.active || api === null || getCtoxClient(instanceId) !== api)
        throw new Error("ctox_client_unavailable");
      const next = api.command(type, payload, options);
      setCurrent({ api, handle: next });
      return next;
    },
    [api, instanceId, scope],
  );
  return { command, handle, status };
}
