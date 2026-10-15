/**
 * Projektliste der Seitenleiste (#579, #580): volle Namen, eindeutige
 * Einträge und Suche. Gleichnamige Projekte (auch nur in Groß-/Kleinschreibung
 * verschieden, „metric“/„Metric“) bekommen eine Meta-Zeile aus Instanz oder
 * Ordner, damit zwei Zeilen nie gleich aussehen.
 */

export interface ProjectSwitcherSource {
  readonly id: string;
  readonly title: string;
  /** Unterscheidungsmerkmale in Vorrangfolge, z. B. Ordnername, Instanz. */
  readonly metaCandidates?: ReadonlyArray<string | null | undefined>;
}

export interface ProjectSwitcherEntry {
  readonly id: string;
  readonly title: string;
  /** Nur gesetzt, wenn ein gleichnamiges Projekt existiert. */
  readonly meta: string | null;
}

/** Ab dieser Anzahl zeigt die Liste ein Suchfeld. */
export const PROJECT_SWITCHER_SEARCH_THRESHOLD = 8;

const nameKey = (title: string) => title.trim().toLocaleLowerCase("de");

/** Letztes Pfadsegment, damit ein Ordner und kein Pfad sichtbar wird. */
export function projectFolderName(path: string | null | undefined): string | null {
  if (!path) return null;
  const segments = path.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? null;
}

function cleanCandidates(source: ProjectSwitcherSource): string[] {
  const values: string[] = [];
  for (const candidate of source.metaCandidates ?? []) {
    const value = candidate?.trim();
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

export function buildProjectSwitcherEntries(
  sources: ReadonlyArray<ProjectSwitcherSource>,
): ProjectSwitcherEntry[] {
  const groups = new Map<string, ProjectSwitcherSource[]>();
  for (const source of sources) {
    const key = nameKey(source.title);
    const group = groups.get(key);
    if (group) group.push(source);
    else groups.set(key, [source]);
  }
  const metaById = new Map<string, string | null>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const candidates = group.map(cleanCandidates);
    // Erstes Merkmal, das innerhalb der Gruppe alle Einträge trennt.
    const depth = Math.max(0, ...candidates.map((values) => values.length));
    let chosen: Array<string | null> | null = null;
    for (let index = 0; index < depth; index += 1) {
      const column = candidates.map((values) => values[index] ?? null);
      const present = column.filter((value): value is string => value !== null);
      if (present.length === column.length && new Set(present).size === present.length) {
        chosen = column;
        break;
      }
    }
    group.forEach((source, position) => {
      const meta =
        chosen?.[position] ??
        candidates[position]?.find(
          (value) => !candidates.some((other, at) => at !== position && other.includes(value)),
        ) ??
        candidates[position]?.[0] ??
        null;
      metaById.set(source.id, meta);
    });
    // Bleiben zwei Zeilen gleich, nummeriert die Reihenfolge sie durch.
    const seen = new Map<string, number>();
    for (const source of group) {
      const label = `${source.title}\u0000${metaById.get(source.id) ?? ""}`;
      const count = (seen.get(label) ?? 0) + 1;
      seen.set(label, count);
      if (count > 1) {
        const base = metaById.get(source.id);
        metaById.set(source.id, base ? `${base} · ${count}` : `${count}`);
      }
    }
  }
  return sources.map((source) => ({
    id: source.id,
    title: source.title,
    meta: metaById.get(source.id) ?? null,
  }));
}

export function filterProjectSwitcherEntries(
  entries: ReadonlyArray<ProjectSwitcherEntry>,
  query: string,
): ProjectSwitcherEntry[] {
  const needle = query.trim().toLocaleLowerCase("de");
  if (needle.length === 0) return [...entries];
  return entries.filter((entry) =>
    `${entry.title} ${entry.meta ?? ""}`.toLocaleLowerCase("de").includes(needle),
  );
}
