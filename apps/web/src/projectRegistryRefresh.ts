import type { DesktopCtoxBridge } from "@workjet/contracts";

const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** One in-flight query, one coalesced event and one bounded-backoff background timer. */
export function createProjectRegistryRefresh(run: () => Promise<boolean | void>) {
  let cancelled = false;
  let running: Promise<void> | null = null;
  let queued = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (success: boolean) => {
    clearTimer();
    if (cancelled) return;
    failures = success ? 0 : failures + 1;
    const delay = success ? 60_000 : RETRY_DELAYS[Math.min(failures - 1, RETRY_DELAYS.length - 1)]!;
    timer = setTimeout(() => {
      void refresh().catch(() => undefined);
    }, delay);
  };
  const refresh = (): Promise<void> => {
    if (cancelled) return Promise.resolve();
    clearTimer();
    if (running !== null) {
      queued = true;
      return running;
    }
    running = (async () => {
      do {
        queued = false;
        try {
          schedule((await run()) !== false);
        } catch (error) {
          schedule(false);
          throw error;
        }
      } while (queued && !cancelled);
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
      clearTimer();
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
