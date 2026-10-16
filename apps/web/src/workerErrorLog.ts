import { useSyncExternalStore } from "react";

/**
 * Raw worker errors from the project feed. The feed shows only the plain German
 * line plus one action (UI-Vertrag §2); the raw text lives here and is listed
 * under Einstellungen › Diagnose › Letzte Fehler.
 */
export type WorkerErrorLogEntry = {
  readonly key: string;
  readonly worker: string;
  readonly raw: string;
  readonly at: string;
};

const MAX_ENTRIES = 20;
let entries: readonly WorkerErrorLogEntry[] = [];
const listeners = new Set<() => void>();

export function recordWorkerErrors(next: readonly WorkerErrorLogEntry[]): void {
  let changed = false;
  let list = entries;
  for (const entry of next) {
    const existing = list.find((item) => item.key === entry.key);
    if (existing && existing.raw === entry.raw && existing.at === entry.at) continue;
    list = [entry, ...list.filter((item) => item.key !== entry.key)];
    changed = true;
  }
  if (!changed) return;
  entries = [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_ENTRIES);
  for (const listener of listeners) listener();
}

export function workerErrorLogSnapshot(): readonly WorkerErrorLogEntry[] {
  return entries;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWorkerErrorLog(): readonly WorkerErrorLogEntry[] {
  return useSyncExternalStore(subscribe, workerErrorLogSnapshot, workerErrorLogSnapshot);
}

/** Test helper. */
export function resetWorkerErrorLog(): void {
  entries = [];
  for (const listener of listeners) listener();
}
