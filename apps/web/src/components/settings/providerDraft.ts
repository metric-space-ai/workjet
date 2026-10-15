import { useSyncExternalStore } from "react";
import type { WorkjetGatewayProvider } from "@workjet/contracts";

/**
 * Der Entwurf eines neuen Anbieterkontos („+ Hinzufügen“ → Anbieter).
 *
 * Er lebt außerhalb der Komponente: ein Neuaufbau der Seite (Instanz-
 * Wiederverbindung, Rechner-Katalog lädt neu) darf ihn nicht verwerfen.
 * Nur „Entfernen“ in der Karte oder ein tatsächlich angelegtes Konto beenden
 * ihn. Der Schlüssel selbst ist nie Teil des Entwurfs.
 */
export type ProviderDraftMode = "subscription" | "key";
export interface ProviderDraft {
  readonly provider: WorkjetGatewayProvider;
  readonly mode: ProviderDraftMode;
  /** Das Schlüsselformular ist aufgeklappt. */
  readonly keyFormOpen: boolean;
}

const listeners = new Set<() => void>();
let current: ProviderDraft | null = null;

export function readProviderDraft(): ProviderDraft | null {
  return current;
}

export function setProviderDraft(next: ProviderDraft | null): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function updateProviderDraft(patch: Partial<ProviderDraft>): void {
  if (current) setProviderDraft({ ...current, ...patch });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useProviderDraft(): ProviderDraft | null {
  return useSyncExternalStore(subscribe, readProviderDraft, () => null);
}
