import * as Schema from "effect/Schema";
import { useEffect, useMemo } from "react";
import { WorkjetExitModelAssessment } from "@workjet/contracts";
import type { PromptedProjectKpis } from "./projectKpis";

/**
 * Letzter bekannter Stand einer Projektkachel je Instanz + Projekt (localStorage).
 *
 * Gespeichert werden nur Werte, die die Instanz erfolgreich geliefert hat: die
 * KPI-Projektion (Sätze, Bezeichnungen, Anzeigewerte) und die Exit-Bewertung aus
 * der Projektliste. Ein gescheiterter Abruf schreibt nie, ersetzt also nie einen
 * bekannten Wert. Sobald `useCtoxQuery` lokal liefert, schaltet
 * `PROJECT_CARD_CACHE_ENABLED = false` diesen Rückfall ab, ohne die Kachel zu ändern.
 */
export const PROJECT_CARD_CACHE_ENABLED = true;

const KEY_PREFIX = "workjet.projectCard.v1:";

type CachedProjectCard = {
  readonly kpis?: PromptedProjectKpis;
  readonly exitModel?: WorkjetExitModelAssessment | null;
};

export function projectCardCacheKey(instanceId: string, projectId: string): string {
  return `${KEY_PREFIX}${instanceId}:${projectId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isPromptedKpis(value: unknown, projectId: string): value is PromptedProjectKpis {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<PromptedProjectKpis>;
  return (
    record.project_id === projectId &&
    typeof record.revision === "number" &&
    Array.isArray(record.items) &&
    record.items.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { prompt?: { prompt?: unknown } }).prompt?.prompt === "string" &&
        typeof (item as { result?: { status?: unknown } }).result?.status === "string",
    )
  );
}

const decodeExitModel = Schema.decodeUnknownOption(WorkjetExitModelAssessment);

function readEntry(instanceId: string, projectId: string): CachedProjectCard {
  if (!PROJECT_CARD_CACHE_ENABLED) return {};
  try {
    const raw = storage()?.getItem(projectCardCacheKey(instanceId, projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entry: { kpis?: PromptedProjectKpis; exitModel?: WorkjetExitModelAssessment | null } = {};
    if (isPromptedKpis(parsed.kpis, projectId)) entry.kpis = parsed.kpis;
    if (parsed.exitModel === null) entry.exitModel = null;
    else if (parsed.exitModel !== undefined) {
      const decoded = decodeExitModel(parsed.exitModel);
      if (decoded._tag === "Some" && decoded.value.project_id === projectId)
        entry.exitModel = decoded.value;
    }
    return entry;
  } catch {
    return {};
  }
}

function writeEntry(instanceId: string, projectId: string, patch: CachedProjectCard): void {
  if (!PROJECT_CARD_CACHE_ENABLED) return;
  try {
    const target = storage();
    if (!target) return;
    const next = { ...readEntry(instanceId, projectId), ...patch };
    target.setItem(projectCardCacheKey(instanceId, projectId), JSON.stringify(next));
  } catch {
    // Voller oder gesperrter Speicher: die Kachel zeigt dann nur den Live-Stand.
  }
}

export function readCachedProjectKpis(
  instanceId: string,
  projectId: string,
): PromptedProjectKpis | undefined {
  return readEntry(instanceId, projectId).kpis;
}

/** Nur erfolgreich gelesene KPIs; `undefined` (unbekannt) schreibt nichts. */
export function writeCachedProjectKpis(
  instanceId: string,
  projectId: string,
  kpis: PromptedProjectKpis,
): void {
  if (kpis.project_id !== projectId) return;
  writeEntry(instanceId, projectId, { kpis });
}

/** `undefined` = nie gelesen; `null` = gelesen, keine Bewertung. */
export function readCachedExitModel(
  instanceId: string,
  projectId: string,
): WorkjetExitModelAssessment | null | undefined {
  return readEntry(instanceId, projectId).exitModel;
}

export function writeCachedExitModel(
  instanceId: string,
  projectId: string,
  exitModel: WorkjetExitModelAssessment | null,
): void {
  if (exitModel !== null && exitModel.project_id !== projectId) return;
  writeEntry(instanceId, projectId, { exitModel });
}

/** Der beste bekannte Stand: live vor gespeichert. `undefined` heißt unbekannt. */
export function bestKnownProjectCard(
  live: {
    readonly kpis: PromptedProjectKpis | undefined;
    /** `undefined`: Projektliste ohne Konfiguration (unbekannt). */
    readonly exitModel: WorkjetExitModelAssessment | null | undefined;
  },
  cached: CachedProjectCard,
): {
  readonly kpis: PromptedProjectKpis | undefined;
  readonly exitModel: WorkjetExitModelAssessment | null | undefined;
} {
  return {
    kpis: live.kpis ?? cached.kpis,
    exitModel: live.exitModel !== undefined ? live.exitModel : cached.exitModel,
  };
}

/**
 * Kachel-Hook: liest den gespeicherten Stand einmal je Instanz + Projekt und
 * schreibt jeden erfolgreichen Live-Stand zurück.
 */
export function useLastKnownProjectCard(
  instanceId: string | null,
  projectId: string,
  live: {
    readonly kpis: PromptedProjectKpis | undefined;
    readonly exitModel: WorkjetExitModelAssessment | null | undefined;
  },
) {
  const cached = useMemo(
    () => (instanceId === null ? {} : readEntry(instanceId, projectId)),
    [instanceId, projectId],
  );
  useEffect(() => {
    if (instanceId === null || live.kpis === undefined) return;
    writeCachedProjectKpis(instanceId, projectId, live.kpis);
  }, [instanceId, projectId, live.kpis]);
  useEffect(() => {
    if (instanceId === null || live.exitModel === undefined) return;
    writeCachedExitModel(instanceId, projectId, live.exitModel);
  }, [instanceId, projectId, live.exitModel]);
  return bestKnownProjectCard(live, cached);
}
