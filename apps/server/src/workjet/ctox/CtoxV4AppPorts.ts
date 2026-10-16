import type { CtoxV4AppPort } from "@workjet/shared/ctoxV4AppData";

/**
 * V4 gate on the server side (E49): a CTOX instance takes the V4 path only while the host has
 * bound its kernel client here. Without a binding every caller keeps today's V3 route (MCP,
 * loopback HTTP, SSH) unchanged until the post-cutover cleanup. The host bootstrap owns the
 * binding; this module never creates a client, a transport or a fallback.
 *
 * Keys: the CTOX instance id where the caller knows it, and the origin of the instance's daemon
 * or MCP endpoint for callers that only hold a target (mailbox, Luma, decision hub).
 */
const byInstance = new Map<string, CtoxV4AppPort>();
const byOrigin = new Map<string, CtoxV4AppPort>();

const originOf = (endpoint: string): string | null => {
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
};

export function bindCtoxV4AppPort(
  instance: { readonly instanceId: string; readonly endpoint?: string },
  port: CtoxV4AppPort,
): () => void {
  if (!instance.instanceId.trim()) throw new Error("invalid_ctox_instance");
  const origin = instance.endpoint === undefined ? null : originOf(instance.endpoint);
  byInstance.set(instance.instanceId, port);
  if (origin !== null) byOrigin.set(origin, port);
  return () => {
    if (byInstance.get(instance.instanceId) === port) byInstance.delete(instance.instanceId);
    if (origin !== null && byOrigin.get(origin) === port) byOrigin.delete(origin);
  };
}

export function resolveCtoxV4AppPortForInstance(instanceId: string): CtoxV4AppPort | null {
  return byInstance.get(instanceId) ?? null;
}

export function resolveCtoxV4AppPortForEndpoint(endpoint: string): CtoxV4AppPort | null {
  const origin = originOf(endpoint);
  return origin === null ? null : (byOrigin.get(origin) ?? null);
}
