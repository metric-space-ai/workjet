// The launch context a device invitation returned (E54.4). It is kept per instance until the V4
// host bootstrap (#806) reads it; its hello offer carries a single-use E50 ticket, so it is handed
// out exactly once. Storing it notifies the bootstrap, which then mounts that instance.

type Listener = (instanceId: string) => void;

const contexts = new Map<string, { readonly v4: unknown }>();
const listeners = new Set<Listener>();

export function storePairedV4LaunchContext(instanceId: string, payload: { readonly v4: unknown }) {
  contexts.set(instanceId, payload);
  for (const listener of listeners) listener(instanceId);
}

/** Hands out the stored context once (the offer's E50 ticket is single-use). */
export function takePairedV4LaunchContext(instanceId: string): { readonly v4: unknown } | undefined {
  const payload = contexts.get(instanceId);
  contexts.delete(instanceId);
  return payload;
}

export function hasPairedV4LaunchContext(instanceId: string): boolean {
  return contexts.has(instanceId);
}

export function subscribePairedV4LaunchContexts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. */
export function resetPairedV4LaunchContexts() {
  contexts.clear();
  listeners.clear();
}
