import type { CtoxAppApi } from "./stub/index";

export type * from "./stub/index";

/** The Shell owns the API and its instance/user store. Workjet owns no transport. */
export function createCtoxClient(api: CtoxAppApi): CtoxAppApi {
  if (api.version !== "4.0" || api.app.id !== "workjet" || !api.actor.id)
    throw new Error("invalid_ctox_app_api");
  return api;
}

const clients = new Map<string, { api: CtoxAppApi }>();
const scopes = new WeakMap<CtoxAppApi, string>();
const listeners = new Set<() => void>();

export function getCtoxClient(instanceId: string | null): CtoxAppApi | null {
  return instanceId === null ? null : (clients.get(instanceId)?.api ?? null);
}

export function subscribeCtoxClients(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by the Shell mount adapter, disposed on unmount/logout. No implicit stub or guest fallback. */
export function bindCtoxClient(instanceId: string, api: CtoxAppApi): () => void {
  if (!instanceId.trim()) throw new Error("invalid_ctox_instance");
  const client = createCtoxClient(api);
  const scope = scopes.get(client);
  if (scope !== undefined && scope !== instanceId) throw new Error("invalid_ctox_instance_scope");
  scopes.set(client, instanceId);
  const binding = { api: client };
  clients.set(instanceId, binding);
  for (const listener of listeners) listener();
  return () => {
    if (clients.get(instanceId) !== binding) return;
    clients.delete(instanceId);
    for (const listener of listeners) listener();
  };
}
