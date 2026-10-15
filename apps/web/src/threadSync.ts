import type { EnvironmentThreadStatus } from "@workjet/client-runtime/state/threads";

export type ThreadSyncPhase = "loading" | "syncing";

/** Laden bleibt still; erst nach dieser Zeit erscheint die Statuszeile (UI-Vertrag §1.3). */
export const THREAD_SYNC_NOTICE_MS = 10_000;

/** Deutsche Statuszeile, wenn das Laden länger als 10 s dauert. */
export const THREAD_SYNC_SLOW_LINE = "Nachrichten nicht geladen";
export const THREAD_SYNC_RETRY_LABEL = "Erneut versuchen";

export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
}): ThreadSyncPhase | null {
  if (!input.shellExists) {
    return null;
  }

  switch (input.status) {
    case "empty":
    case "cached":
    case "synchronizing":
      return input.detailExists ? "syncing" : "loading";
    case "deleted":
    case "live":
      return null;
  }
}
