import { useSyncExternalStore } from "react";

import type { SpeechFailureReason } from "../../lib/workjetSpeechSettings";

/**
 * Instanzen, deren CTOX keine Spracheinstellungen kennt (`core_outdated`).
 * Für sie verschwindet der Navigationseintrag „Sprachausgabe“, statt eine
 * Anweisung zu zeigen. Die Kenntnis bleibt je Instanz lokal gespeichert.
 */
const STORAGE_KEY = "workjet:speech-unsupported-instances:v1";
const listeners = new Set<() => void>();
let unsupported: ReadonlySet<string> = readStored();

function readStored(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function publish(next: ReadonlySet<string>) {
  unsupported = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Storage is optional; the in-memory state still hides the entry.
  }
  for (const listener of listeners) listener();
}

export function markSpeechSupport(instanceId: string, supported: boolean): void {
  if (supported === !unsupported.has(instanceId)) return;
  const next = new Set(unsupported);
  if (supported) next.delete(instanceId);
  else next.add(instanceId);
  publish(next);
}

export function isSpeechSupported(instanceId: string | null): boolean {
  return instanceId === null || !unsupported.has(instanceId);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSpeechSupported(instanceId: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isSpeechSupported(instanceId),
    () => true,
  );
}

/**
 * Was die Seite bei einem Lesefehler tut: `hide` (Fähigkeit fehlt: Eintrag
 * weg), `denied` (eine kurze Zeile ohne Knopf) oder `retry` (still erneut
 * lesen, bis dahin „—“).
 */
export function speechReadFailureView(
  reason: SpeechFailureReason | null,
): "hide" | "denied" | "retry" {
  if (reason === "core_outdated") return "hide";
  if (reason === "access_denied") return "denied";
  return "retry";
}
