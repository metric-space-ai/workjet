/**
 * Renderer→server proxy for the V4 app API (slice C, C3). The kernel client lives in the
 * renderer; the Workjet server (mailbox cycle, worker dispatcher, Luma/decision clients) reaches
 * it through the existing WebSocket RPC: the server streams requests to the renderer that holds
 * the bound instance, the renderer answers each one with a reply RPC. Both halves live here so
 * one test can run them back to back without a socket.
 *
 * - Only bound instances, only for the running session: the server registers the port after the
 *   renderer delivered the first value of every mirrored collection and removes it when the
 *   stream ends (unmount, logout, reconnect). There is no V3 fallback for a V4 instance.
 * - Reads stay synchronous on the server: the Workjet-owned collections plus the approval
 *   projection are mirrored (live query `{}` in the renderer) and queried locally. Any other
 *   collection is a forwarded live subscription whose value arrives asynchronously.
 * - Writes and commands are forwarded; their local/result promises and the command status are
 *   answered by the renderer. The server never invents a result.
 */
import {
  CTOX_APPROVAL_REQUESTS,
  WORKJET_LUMA_STATE,
  WORKJET_MAILBOX_ENVELOPES,
  WORKJET_WORKER_DISPATCH_INTENTS,
  WORKJET_WORKER_DISPATCH_OUTCOMES,
  WORKJET_WORKER_DISPATCH_SOURCES,
  type CtoxV4AppPort,
  type CtoxV4CommandHandle,
  type CtoxV4CommandState,
  type CtoxV4Live,
  type CtoxV4Query,
  type CtoxV4WriteHandle,
  type CtoxV4WriteResult,
} from "./ctoxV4AppData.ts";

/** Collections the server mirrors so its reads stay synchronous. */
export const CTOX_V4_PROXY_MIRRORED_COLLECTIONS: ReadonlyArray<string> = [
  WORKJET_MAILBOX_ENVELOPES,
  WORKJET_LUMA_STATE,
  WORKJET_WORKER_DISPATCH_SOURCES,
  WORKJET_WORKER_DISPATCH_INTENTS,
  WORKJET_WORKER_DISPATCH_OUTCOMES,
  CTOX_APPROVAL_REQUESTS,
];

// ---------------------------------------------------------------- wire

/** Server → renderer. `subscribe` with `id` is a live get, without it a live query. */
export type CtoxV4ProxyRequest =
  | {
      readonly op: "subscribe";
      readonly subId: string;
      readonly collection: string;
      readonly query?: CtoxV4Query;
      readonly id?: string;
    }
  | { readonly op: "unsubscribe"; readonly subId: string }
  | {
      readonly op: "put";
      readonly reqId: string;
      readonly collection: string;
      readonly doc: Record<string, unknown>;
    }
  | {
      readonly op: "patch";
      readonly reqId: string;
      readonly collection: string;
      readonly id: string;
      readonly patch: object;
    }
  | {
      readonly op: "command";
      readonly reqId: string;
      readonly type: string;
      readonly payload: object;
      readonly options?: { readonly record_id?: string; readonly idempotency_key?: string };
    };

/** Renderer → server. */
export type CtoxV4ProxyReply =
  | { readonly kind: "value"; readonly subId: string; readonly value: unknown }
  | {
      readonly kind: "local";
      readonly reqId: string;
      readonly ok: boolean;
      readonly error?: string;
    }
  | { readonly kind: "result"; readonly reqId: string; readonly result: CtoxV4WriteResult }
  | { readonly kind: "status"; readonly reqId: string; readonly state: CtoxV4CommandState };

// ---------------------------------------------------------------- local query evaluation

const pathOf = (doc: unknown, path: string): unknown => {
  let value: unknown = doc;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
};
const same = (left: unknown, right: unknown): boolean =>
  left === right ||
  ((left === undefined || left === null) && right === null) ||
  (typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null &&
    JSON.stringify(left) === JSON.stringify(right));
const order = (left: unknown, right: unknown): number =>
  left === right
    ? 0
    : left === undefined || left === null
      ? -1
      : right === undefined || right === null
        ? 1
        : (left as number | string) < (right as number | string)
          ? -1
          : 1;

function matches(value: unknown, condition: unknown): boolean {
  if (condition === null || typeof condition !== "object" || Array.isArray(condition))
    return same(value, condition);
  const entries = Object.entries(condition as Record<string, unknown>);
  if (!entries.every(([key]) => key.startsWith("$"))) return same(value, condition);
  return entries.every(([operator, operand]) => {
    switch (operator) {
      case "$eq":
        return same(value, operand);
      case "$ne":
        return !same(value, operand);
      case "$gt":
        return value !== undefined && value !== null && order(value, operand) > 0;
      case "$gte":
        return value !== undefined && value !== null && order(value, operand) >= 0;
      case "$lt":
        return value !== undefined && value !== null && order(value, operand) < 0;
      case "$lte":
        return value !== undefined && value !== null && order(value, operand) <= 0;
      case "$in":
        return Array.isArray(operand) && operand.some((entry) => same(value, entry));
      case "$nin":
        return Array.isArray(operand) && !operand.some((entry) => same(value, entry));
      case "$exists":
        return (value !== undefined) === Boolean(operand);
      default:
        // An operator the mirror does not know must never widen a result.
        return false;
    }
  });
}

/** Mango subset of the kernel query (equality, comparison, $in/$nin/$exists, dotted paths). */
export function matchesCtoxV4Selector(
  doc: unknown,
  selector: Record<string, unknown> | undefined,
): boolean {
  if (selector === undefined) return true;
  return Object.entries(selector).every(([path, condition]) =>
    path === "$and"
      ? Array.isArray(condition) &&
        condition.every((part) => matchesCtoxV4Selector(doc, part as Record<string, unknown>))
      : path === "$or"
        ? Array.isArray(condition) &&
          condition.some((part) => matchesCtoxV4Selector(doc, part as Record<string, unknown>))
        : matches(pathOf(doc, path), condition),
  );
}

export function applyCtoxV4Query<T>(rows: ReadonlyArray<T>, query: CtoxV4Query): T[] {
  const selected = rows.filter((row) => matchesCtoxV4Selector(row, query.selector));
  for (const rule of [...(query.sort ?? [])].reverse())
    for (const [field, direction] of Object.entries(rule))
      selected.sort(
        (left, right) =>
          order(pathOf(left, field), pathOf(right, field)) * (direction === "desc" ? -1 : 1),
      );
  return query.limit === undefined ? selected : selected.slice(0, query.limit);
}

// ---------------------------------------------------------------- server half

interface Listeners<T> {
  value: T;
  readonly listeners: Set<(value: T) => void>;
}
const emit = <T>(slot: Listeners<T>, value: T) => {
  slot.value = value;
  for (const listener of slot.listeners) listener(value);
};
const liveOf = <T>(slot: Listeners<T>, project: (value: unknown) => T): CtoxV4Live<T> => ({
  get: () => project(slot.value),
  subscribe: (listener) => {
    const wrapped = (value: unknown) => listener(project(value));
    slot.listeners.add(wrapped as (value: T) => void);
    return () => slot.listeners.delete(wrapped as (value: T) => void);
  },
});

export interface CtoxV4ProxyServer {
  readonly port: CtoxV4AppPort;
  /** Resolves once every mirrored collection delivered its first value. */
  readonly ready: Promise<void>;
  readonly receive: (reply: CtoxV4ProxyReply) => void;
  /** Ends the session: pending writes reject `proxy_closed`, subscriptions go silent. */
  readonly close: () => void;
}

export function createCtoxV4ProxyServer(options: {
  readonly actor: { readonly id: string; readonly role: string };
  readonly send: (request: CtoxV4ProxyRequest) => void;
  readonly mirrored?: ReadonlyArray<string>;
}): CtoxV4ProxyServer {
  const mirrored = options.mirrored ?? CTOX_V4_PROXY_MIRRORED_COLLECTIONS;
  let sequence = 0;
  let closed = false;
  const next = (prefix: string) => `${prefix}-${++sequence}`;
  const mirrors = new Map<string, Listeners<Array<Record<string, unknown>>>>();
  const subs = new Map<string, Listeners<unknown>>();
  const pendingFirst = new Set<string>();
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  type Pending = {
    local: { resolve: () => void; reject: (error: Error) => void };
    result: { resolve: (result: CtoxV4WriteResult) => void };
    status?: Listeners<CtoxV4CommandState>;
  };
  const writes = new Map<string, Pending>();

  const send = (request: CtoxV4ProxyRequest) => {
    if (!closed) options.send(request);
  };
  for (const collection of mirrored) {
    const subId = `mirror:${collection}`;
    mirrors.set(collection, { value: [], listeners: new Set() });
    pendingFirst.add(subId);
    send({ op: "subscribe", subId, collection, query: {} });
  }
  if (pendingFirst.size === 0) markReady();

  const forwarded = <T>(
    collection: string,
    target: { query?: CtoxV4Query; id?: string },
    empty: T,
  ): CtoxV4Live<T> => {
    const subId = next("sub");
    const slot: Listeners<unknown> = { value: empty, listeners: new Set() };
    const live = liveOf<T>(slot, (value) => value as T);
    let active = 0;
    return {
      get: live.get,
      subscribe: (listener) => {
        const off = live.subscribe(listener);
        if (active++ === 0) {
          subs.set(subId, slot);
          send({ op: "subscribe", subId, collection, ...target });
        }
        return () => {
          off();
          if (--active === 0) {
            subs.delete(subId);
            send({ op: "unsubscribe", subId });
          }
        };
      },
    };
  };

  const write = (request: CtoxV4ProxyRequest & { reqId: string }, command: boolean) => {
    let localResolve!: () => void;
    let localReject!: (error: Error) => void;
    let resultResolve!: (result: CtoxV4WriteResult) => void;
    const local = new Promise<void>((resolve, reject) => {
      localResolve = resolve;
      localReject = reject;
    });
    const result = new Promise<CtoxV4WriteResult>((resolve) => {
      resultResolve = resolve;
    });
    // Callers that only await `result` must not see an unhandled local rejection.
    local.catch(() => {});
    const pending: Pending = {
      local: { resolve: localResolve, reject: localReject },
      result: { resolve: resultResolve },
      ...(command ? { status: { value: { status: "queued" }, listeners: new Set() } } : {}),
    };
    writes.set(request.reqId, pending);
    if (closed) {
      localReject(new Error("proxy_closed"));
      resultResolve({ status: "rejected", code: "proxy_closed" });
    } else send(request);
    return { local, result, pending };
  };

  const port: CtoxV4AppPort = {
    actor: options.actor,
    query: <T>(collection: string, query: CtoxV4Query) => {
      const mirror = mirrors.get(collection);
      if (mirror === undefined) return forwarded<T[]>(collection, { query }, []);
      return liveOf<T[]>(mirror, (rows) =>
        applyCtoxV4Query(rows as ReadonlyArray<T>, query ?? {}),
      );
    },
    get: <T>(collection: string, id: string) => {
      const mirror = mirrors.get(collection);
      if (mirror === undefined) return forwarded<T | null>(collection, { id }, null);
      return liveOf<T | null>(
        mirror,
        (rows) =>
          ((rows as Array<Record<string, unknown>>).find((row) => row.id === id) ??
            null) as T | null,
      );
    },
    put: (collection, doc): CtoxV4WriteHandle => {
      const { local, result } = write(
        { op: "put", reqId: next("put"), collection, doc: doc as Record<string, unknown> },
        false,
      );
      return { local, result };
    },
    patch: (collection, id, patch): CtoxV4WriteHandle => {
      const { local, result } = write(
        { op: "patch", reqId: next("patch"), collection, id, patch },
        false,
      );
      return { local, result };
    },
    command: (type, payload, commandOptions): CtoxV4CommandHandle => {
      const reqId = next("cmd");
      const { local, result, pending } = write(
        {
          op: "command",
          reqId,
          type,
          payload,
          ...(commandOptions === undefined ? {} : { options: commandOptions }),
        },
        true,
      );
      // The kernel id lives in the renderer; the proxy id is only a correlation handle.
      return {
        id: reqId,
        status: liveOf(pending.status!, (state) => state as CtoxV4CommandState),
        local,
        result,
      };
    },
  };

  const receive = (reply: CtoxV4ProxyReply) => {
    if (closed) return;
    if (reply.kind === "value") {
      if (reply.subId.startsWith("mirror:")) {
        const mirror = mirrors.get(reply.subId.slice("mirror:".length));
        if (mirror === undefined || !Array.isArray(reply.value)) return;
        emit(mirror, reply.value as Array<Record<string, unknown>>);
        if (pendingFirst.delete(reply.subId) && pendingFirst.size === 0) markReady();
        return;
      }
      const slot = subs.get(reply.subId);
      if (slot !== undefined) emit(slot, reply.value);
      return;
    }
    const pending = writes.get(reply.reqId);
    if (pending === undefined) return;
    if (reply.kind === "local") {
      if (reply.ok) pending.local.resolve();
      else pending.local.reject(new Error(reply.error ?? "write_failed"));
    } else if (reply.kind === "result") {
      pending.result.resolve(reply.result);
      if (pending.status === undefined || reply.result.status === "rejected")
        writes.delete(reply.reqId);
    } else if (pending.status !== undefined) {
      emit(pending.status, reply.state);
      if (["done", "failed", "cancelled", "rejected"].includes(reply.state.status))
        writes.delete(reply.reqId);
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const pending of writes.values()) {
      pending.local.reject(new Error("proxy_closed"));
      pending.result.resolve({ status: "rejected", code: "proxy_closed" });
      if (pending.status !== undefined)
        emit(pending.status, { status: "failed", error: "proxy_closed: renderer detached" });
    }
    writes.clear();
    subs.clear();
  };
  return { port, ready, receive, close };
}

// ---------------------------------------------------------------- renderer half

/** The kernel API surface the renderer half needs (`CtoxAppApi` is structurally wider). */
export interface CtoxV4ProxyClientApi {
  query(collection: string, query: CtoxV4Query): CtoxV4Live<unknown[]>;
  get(collection: string, id: string): CtoxV4Live<unknown>;
  put(collection: string, doc: { id: string }): CtoxV4WriteHandle;
  patch(collection: string, id: string, patch: object): CtoxV4WriteHandle;
  command(
    type: string,
    payload: object,
    options?: { record_id?: string; idempotency_key?: string },
  ): CtoxV4CommandHandle;
}

export interface CtoxV4ProxyClient {
  readonly handle: (request: CtoxV4ProxyRequest) => void;
  /** Drops every live subscription the server opened (stream end or unbind). */
  readonly close: () => void;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "rejected"]);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function serveCtoxV4Proxy(
  api: CtoxV4ProxyClientApi,
  reply: (message: CtoxV4ProxyReply) => void,
): CtoxV4ProxyClient {
  const subscriptions = new Map<string, () => void>();
  let closed = false;
  const send = (value: CtoxV4ProxyReply) => {
    if (!closed) reply(value);
  };
  const forwardWrite = (reqId: string, handle: CtoxV4WriteHandle) => {
    handle.local.then(
      () => send({ kind: "local", reqId, ok: true }),
      (error: unknown) => send({ kind: "local", reqId, ok: false, error: message(error) }),
    );
    handle.result.then(
      (result) => send({ kind: "result", reqId, result }),
      (error: unknown) =>
        send({ kind: "result", reqId, result: { status: "rejected", reason: message(error) } }),
    );
  };
  const handle = (request: CtoxV4ProxyRequest) => {
    if (closed) return;
    switch (request.op) {
      case "subscribe": {
        subscriptions.get(request.subId)?.();
        const live =
          request.id === undefined
            ? api.query(request.collection, request.query ?? {})
            : api.get(request.collection, request.id);
        let last: string | undefined;
        const push = (value: unknown) => {
          // Kernel live stores re-emit unchanged snapshots; the socket carries only changes.
          const encoded = JSON.stringify(value ?? null);
          if (encoded === last) return;
          last = encoded;
          send({ kind: "value", subId: request.subId, value: value ?? null });
        };
        const off = live.subscribe(push);
        subscriptions.set(request.subId, off);
        push(live.get());
        return;
      }
      case "unsubscribe":
        subscriptions.get(request.subId)?.();
        subscriptions.delete(request.subId);
        return;
      case "put":
        try {
          forwardWrite(
            request.reqId,
            api.put(request.collection, request.doc as Record<string, unknown> & { id: string }),
          );
        } catch (error) {
          send({ kind: "local", reqId: request.reqId, ok: false, error: message(error) });
          send({
            kind: "result",
            reqId: request.reqId,
            result: { status: "rejected", reason: message(error) },
          });
        }
        return;
      case "patch":
        try {
          forwardWrite(request.reqId, api.patch(request.collection, request.id, request.patch));
        } catch (error) {
          send({ kind: "local", reqId: request.reqId, ok: false, error: message(error) });
          send({
            kind: "result",
            reqId: request.reqId,
            result: { status: "rejected", reason: message(error) },
          });
        }
        return;
      case "command": {
        let command: CtoxV4CommandHandle;
        try {
          command = api.command(request.type, request.payload, request.options);
        } catch (error) {
          send({ kind: "local", reqId: request.reqId, ok: false, error: message(error) });
          send({
            kind: "result",
            reqId: request.reqId,
            result: { status: "rejected", reason: message(error) },
          });
          return;
        }
        forwardWrite(request.reqId, command);
        let off: (() => void) | undefined;
        let finished = false;
        const push = (state: CtoxV4CommandState) => {
          send({ kind: "status", reqId: request.reqId, state });
          if (TERMINAL.has(state.status)) {
            finished = true;
            off?.();
            subscriptions.delete(request.reqId);
          }
        };
        off = command.status.subscribe(push);
        if (finished) off();
        else subscriptions.set(request.reqId, off);
        return;
      }
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const off of subscriptions.values()) off();
    subscriptions.clear();
  };
  return { handle, close };
}
