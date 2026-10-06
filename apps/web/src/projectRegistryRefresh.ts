import type { DesktopCtoxBridge } from "@workjet/contracts";

/** Preserve a refresh requested while an earlier native query is still pending. */
export function createProjectRegistryRefresh(run: () => Promise<void>) {
  let cancelled = false;
  let running: Promise<void> | null = null;
  let queued = false;
  const refresh = (): Promise<void> => {
    if (cancelled) return Promise.resolve();
    if (running !== null) {
      queued = true;
      return running;
    }
    running = (async () => {
      do {
        queued = false;
        await run();
      } while (queued);
    })().finally(() => {
      running = null;
    });
    return running;
  };
  return {
    refresh,
    cancel: () => {
      cancelled = true;
      queued = false;
    },
  };
}

/** Loading a different guest must never refresh the selected project's scope. */
export function subscribeProjectRegistryWarmGuest(
  instanceId: string,
  refresh: () => void,
  subscribe: DesktopCtoxBridge["onGuestState"],
): () => void {
  return (
    subscribe?.((event) => {
      if (event.instanceId === instanceId && event.state === "warm") refresh();
    }) ?? (() => undefined)
  );
}
