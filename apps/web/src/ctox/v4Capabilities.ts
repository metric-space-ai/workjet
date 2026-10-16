import { getCtoxClient } from "./ctoxClient";

/**
 * Core routes Workjet offers on V4 only when the Core grants them in `hello_ok.capabilities`
 * (E43.2). Until then the UI does not offer the action at all: no button, no hint text.
 */
export const CTOX_SECRET_REQUEST_FULFILL = "ctox.secret.request.fulfill";
export const CTOX_SECRET_REQUEST_DECLINE = "ctox.secret.request.decline";

type GrantedCapabilitiesReader = () => ReadonlyArray<string> | null;

const readers = new Map<string, GrantedCapabilitiesReader>();
/** Routes that answered `unavailable` in this renderer session, per instance. */
const unavailable = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/**
 * The host binds the live `hello_ok` grant of the mounted V4 session (read on every call, so a
 * reconnect hello replaces it). Disposed on unmount.
 */
export function bindV4GrantedCapabilities(
  instanceId: string,
  read: GrantedCapabilitiesReader,
): () => void {
  readers.set(instanceId, read);
  notify();
  return () => {
    if (readers.get(instanceId) !== read) return;
    readers.delete(instanceId);
    notify();
  };
}

/** `null`: no authenticated hello for this instance (yet). */
export function v4GrantedCapabilities(instanceId: string): ReadonlyArray<string> | null {
  const read = readers.get(instanceId);
  if (read === undefined) return null;
  try {
    return read();
  } catch {
    return null;
  }
}

/** Remember for this session that the Core answered `unavailable` for a route. */
export function markV4RouteUnavailable(instanceId: string, route: string): void {
  let routes = unavailable.get(instanceId);
  if (routes === undefined) unavailable.set(instanceId, (routes = new Set()));
  if (routes.has(route)) return;
  routes.add(route);
  notify();
}

/**
 * Whether Workjet may offer a Core route for this instance. V3 (no bound V4 client) keeps its
 * existing paths and answers `true`; V4 needs the grant and no `unavailable` answer this session.
 */
export function ctoxRouteOffered(instanceId: string, route: string): boolean {
  if (getCtoxClient(instanceId) === null) return true;
  if (unavailable.get(instanceId)?.has(route)) return false;
  return v4GrantedCapabilities(instanceId)?.includes(route) ?? false;
}

export function subscribeV4Capabilities(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam only. */
export function resetV4CapabilitiesForTest(): void {
  readers.clear();
  unavailable.clear();
  notify();
}
