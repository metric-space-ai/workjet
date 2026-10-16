import type { WorkjetConnectionSummary } from "@workjet/contracts";

import { ctoxConnectionMatchesSelectedInstance } from "./workjetCtoxConnections";

type PresetConnectionEntry = Pick<
  WorkjetConnectionSummary,
  "connectionId" | "instanceId" | "source" | "status" | "reason"
>;

/**
 * Zustand der Presets-Seite für die gewählte Instanz (UI-Vertrag §1.3):
 * - ready: genau eine Verbindung wird gelesen.
 * - loading: nur solange die Liste noch nie geantwortet hat und < 10 s.
 * - authentication: Anmeldung abgelaufen → „Neu verbinden“.
 * - unreachable: offline, Fehler, nicht unterstützt oder zu lange keine Antwort → „Erneut“.
 * - missing: die Instanz hat keine Verbindung → „Verbinden“.
 */
export type PresetConnectionState<T extends PresetConnectionEntry = PresetConnectionEntry> =
  | { readonly kind: "ready"; readonly connection: T }
  | { readonly kind: "loading" }
  | { readonly kind: "authentication" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "missing" };

/**
 * Mehrere bereite Worker-Quellen derselben nativen Instanz sind gleichwertig:
 * die kanonische `ctox-dev:<tenant>`-Verbindung gewinnt, sonst die kleinste
 * Verbindungs-ID. Zeigen bereite Verbindungen auf verschiedene native
 * Instanzen, wird keine gewählt.
 */
export function presetReadyConnection<T extends PresetConnectionEntry>(
  ready: readonly T[],
  selectedInstanceId: string | null,
): T | undefined {
  if (ready.length === 0) return undefined;
  const canonical = ready.find(
    (entry) => entry.connectionId === `ctox-dev:${selectedInstanceId?.replace(/^managed:/, "")}`,
  );
  if (canonical) return canonical;
  if (new Set(ready.map((entry) => entry.instanceId)).size !== 1) return undefined;
  return ready.toSorted((left, right) => left.connectionId.localeCompare(right.connectionId))[0];
}

export function presetConnectionState<T extends PresetConnectionEntry>(
  entries: readonly T[] | undefined,
  selectedInstanceId: string | null,
  options: { readonly answered: boolean; readonly slow: boolean },
): PresetConnectionState<T> {
  if (entries === undefined || !options.answered)
    return options.slow ? { kind: "unreachable" } : { kind: "loading" };
  const matching = entries.filter((entry) =>
    ctoxConnectionMatchesSelectedInstance(entry, selectedInstanceId),
  );
  const ready = matching.filter((entry) => entry.status === "ready");
  const connection = presetReadyConnection(ready, selectedInstanceId);
  if (connection) return { kind: "ready", connection };
  if (ready.length > 0) return { kind: "unreachable" };
  if (
    matching.some(
      (entry) => entry.status === "needs_auth" || entry.reason === "authentication-required",
    )
  )
    return { kind: "authentication" };
  if (matching.length > 0) return { kind: "unreachable" };
  return { kind: "missing" };
}
