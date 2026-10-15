/**
 * Einstellungen in sieben Seiten (#568, Projekte seit 15.10. im Projekt). Im Entwicklermodus kommen fünf Seiten
 * dazu. Jede frühere Seite ist einer dieser Seiten zugeordnet; Unterseiten
 * (System-Prompts, Verbrauch) tragen ihre Elternseite in der Navigation.
 */
export type SettingsPagePath =
  | "/settings/general"
  | "/settings/business-os"
  | "/settings/computers"
  | "/settings/models"
  | "/settings/workjet"
  | "/settings/speech"
  | "/settings/archived"
  | "/settings/diagnostics"
  | "/settings/harnesses"
  | "/settings/integrations"
  | "/settings/source-control"
  | "/settings/keybindings";

export type SettingsSubpagePath = "/settings/prompts" | "/settings/usage";

export type SettingsPath = SettingsPagePath | SettingsSubpagePath;

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly searchAliases?: ReadonlyArray<string>;
  /** Nur im Entwicklermodus sichtbar: ohne ihn auch kein Suchtreffer (#550). */
  readonly developerOnly?: boolean;
}

/** Die sieben Seiten in Navigationsreihenfolge. */
export const SETTINGS_PAGE_PATHS: readonly SettingsPagePath[] = [
  "/settings/general",
  "/settings/business-os",
  "/settings/computers",
  "/settings/models",
  "/settings/workjet",
  "/settings/speech",
  "/settings/archived",
];

/** Zusätzliche Seiten im Entwicklermodus, in Navigationsreihenfolge. */
export const DEVELOPER_SETTINGS_PAGE_PATHS: readonly SettingsPagePath[] = [
  "/settings/diagnostics",
  "/settings/harnesses",
  // Schnittstellen bleibt Entwicklerseite, bis ctox #708 und die OAuth-Übergabe Main-Prozess → Instanz landen.
  "/settings/integrations",
  "/settings/source-control",
  "/settings/keybindings",
];

const DEVELOPER_PAGES = new Set<SettingsPath>([
  ...DEVELOPER_SETTINGS_PAGE_PATHS,
  "/settings/prompts",
]);

export function isDeveloperSettingsPath(path: SettingsPath): boolean {
  return DEVELOPER_PAGES.has(path);
}

/** Seiten-Bezeichnungen; Navigation, Suche und Brotkrumen lesen von hier. */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "Allgemein",
  "/settings/business-os": "Instanz",
  "/settings/computers": "Rechner",
  "/settings/models": "Modelle",
  "/settings/workjet": "Presets",
  "/settings/speech": "Sprachausgabe",
  "/settings/archived": "Archiv",
  "/settings/diagnostics": "Diagnose",
  "/settings/harnesses": "Harnesses",
  "/settings/integrations": "Schnittstellen",
  "/settings/source-control": "Versionsverwaltung",
  "/settings/keybindings": "Tastenkürzel",
  "/settings/prompts": "System-Prompts",
  "/settings/usage": "Verbrauch",
};

/** Unterseiten zeigen in der Navigation ihre Elternseite als aktiv. */
export const SETTINGS_SUBPAGE_PARENTS: Readonly<Record<SettingsSubpagePath, SettingsPagePath>> = {
  "/settings/prompts": "/settings/workjet",
  "/settings/usage": "/settings/models",
};

/** The nav page a pathname belongs to (a subpage resolves to its parent). */
export function settingsPageForPath(pathname: string): SettingsPagePath | null {
  const normalized = pathname.replace(/\/+$/, "");
  if (normalized in SETTINGS_SUBPAGE_PARENTS) {
    return SETTINGS_SUBPAGE_PARENTS[normalized as SettingsSubpagePath];
  }
  const all = [...SETTINGS_PAGE_PATHS, ...DEVELOPER_SETTINGS_PAGE_PATHS];
  return all.find((path) => normalized === path || normalized.startsWith(`${path}/`)) ?? null;
}

const SETTINGS_SECTION_SEARCH_ALIASES: Partial<Record<SettingsPath, readonly string[]>> = {
  "/settings/general": ["General", "Darstellung", "Appearance"],
  "/settings/business-os": ["Instance", "Instances", "Instanzen", "CTOX"],
  "/settings/computers": ["Computers"],
  "/settings/models": ["Models"],
  "/settings/workjet": ["Lumas", "Luma", "Worker", "Worker-Presets", "Agents"],
  "/settings/speech": ["Speech", "Diktat"],
  "/settings/archived": ["Archive", "Archived conversations", "Unterhaltungen"],
  "/settings/diagnostics": ["Diagnostics"],
  "/settings/harnesses": ["Coding-Agenten", "Coding agents", "CLI"],
  "/settings/integrations": ["Integrations", "Connectors", "Adapter", "Toolhub", "Apps"],
  "/settings/source-control": ["Source Control", "Git"],
  "/settings/keybindings": ["Keybindings", "Shortcuts"],
  "/settings/prompts": ["Prompts"],
  "/settings/usage": ["Usage", "Kosten", "Tokens"],
};

/**
 * Every searchable setting, in result order. This catalog is the single
 * source of truth for anchor ids and visible titles: panels render both via
 * `searchableSetting`, so a retitle happens here once instead of separately
 * in the panel and the index. Labels without an own anchor land on their
 * section (`targetId`) or on the page top.
 */
export const SETTINGS_SEARCH_ITEMS = [
  // ----- Allgemein -----
  {
    id: "color-scheme",
    title: "Farbschema",
    to: "/settings/general",
    searchAliases: ["Hell", "Dunkel", "System", "Theme", "Thema", "Darstellung"],
  },
  {
    id: "font-size",
    title: "Schriftgröße",
    to: "/settings/general",
    searchAliases: ["Schrift", "Font"],
  },
  {
    id: "developer-mode",
    title: "Entwicklermodus",
    to: "/settings/general",
    searchAliases: ["developer", "entwickler"],
  },
  {
    id: "environment-identification",
    title: "Umgebungskennung",
    to: "/settings/general",
    developerOnly: true,
  },
  {
    id: "word-wrap",
    title: "Zeilenumbruch",
    to: "/settings/general",
    developerOnly: true,
  },
  {
    id: "auto-settle-inactive-threads",
    title: "Inaktive ablegen",
    to: "/settings/general",
    developerOnly: true,
  },
  {
    id: "auto-settle-merged-threads",
    title: "Zusammengeführte ablegen",
    to: "/settings/general",
    developerOnly: true,
  },
  {
    id: "hide-whitespace-changes",
    title: "Leerraum ausblenden",
    to: "/settings/general",
    developerOnly: true,
  },
  {
    id: "provider-update-checks",
    title: "Update-Prüfung",
    to: "/settings/general",
    developerOnly: true,
  },
  {
    id: "new-threads",
    title: "Neue Unterhaltungen",
    to: "/settings/general",
    developerOnly: true,
  },
  {
    id: "start-from-origin",
    title: "Von origin starten",
    to: "/settings/general",
    targetId: "new-threads",
    developerOnly: true,
  },
  {
    id: "legacy-plan-mode",
    title: "Plan-Modus",
    to: "/settings/general",
    developerOnly: true,
  },
  {
    id: "legacy-token-streaming",
    title: "Token-Streaming",
    to: "/settings/general",
    developerOnly: true,
  },
  // ----- Instanz -----
  {
    id: "instance-devices",
    title: "Gekoppelte Geräte",
    to: "/settings/business-os",
    searchAliases: ["Geräte", "Workjet-Apps", "Trennen", "Koppeln"],
  },
  // ----- Rechner -----
  {
    id: "workjet-computers",
    title: "Rechner",
    searchAliases: ["computers", "computer", "Rechner hinzufügen"],
    to: "/settings/computers",
  },
  {
    id: "add-project-starts-in",
    title: "Projektordner",
    to: "/settings/computers",
  },
  {
    id: "project-working-copies",
    title: "Arbeitskopien",
    to: "/settings/computers",
    searchAliases: ["Arbeitskopie", "Worktree", "Skripte", "Projekt-Skripte", "Projekte"],
    developerOnly: true,
  },
  // ----- Modelle -----
  {
    id: "workjet-provider-accounts",
    title: "LLM-Anbieter",
    to: "/settings/models",
    searchAliases: ["Konten", "Anbieter", "Gateway"],
  },
  {
    id: "workjet-provider-pools",
    title: "Gateway-Pools",
    to: "/settings/models",
  },
  {
    id: "workjet-llm-routes",
    title: "LLM-Routen",
    to: "/settings/models",
    searchAliases: ["Modell-Routing"],
  },
  {
    id: "usage",
    title: "Verbrauch",
    to: "/settings/usage",
    searchAliases: ["Usage", "Kosten", "Tokens"],
  },
  // ----- Presets -----
  {
    id: "workjet-workers",
    title: "Presets",
    searchAliases: [
      "lumas",
      "luma",
      "worker",
      "workers",
      "agent",
      "agents",
      "Denkstufe",
      "Werkzeuge",
    ],
    to: "/settings/workjet",
  },
  {
    id: "workjet-prompt",
    title: "System-Prompts",
    to: "/settings/prompts",
    developerOnly: true,
  },
  {
    id: "workjet-execution",
    title: "Ausführung",
    to: "/settings/workjet",
    developerOnly: true,
  },
  {
    id: "automatic-worktree-storage",
    title: "Arbeitskopien-Speicher",
    to: "/settings/workjet",
    targetId: "workjet-execution",
    developerOnly: true,
  },
  {
    id: "greppy-runtime",
    title: "Code-Suche",
    to: "/settings/workjet",
    searchAliases: ["greppy", "greppy-laufzeit"],
    developerOnly: true,
  },
  // ----- Sprachausgabe -----
  {
    id: "speech-voice",
    title: "Stimme",
    to: "/settings/speech",
    searchAliases: ["Sprechtempo", "Vorlesen", "Stimmtest"],
  },
  {
    id: "speech-transcription",
    title: "Transkription",
    to: "/settings/speech",
    searchAliases: ["Mistral", "Diktat"],
  },
  // ----- Archiv -----
  {
    id: "archive",
    title: "Archivierte Unterhaltungen",
    to: "/settings/archived",
  },
  // ----- Entwicklermodus -----
  {
    id: "harnesses",
    title: "Coding-Agenten",
    to: "/settings/harnesses",
    searchAliases: ["Harnesses", "Coding agents", "CLI"],
    developerOnly: true,
  },
  {
    id: "import-sessions",
    title: "Sitzungen importieren",
    to: "/settings/harnesses",
    searchAliases: ["import", "history", "histories"],
    developerOnly: true,
  },
  {
    id: "source-control",
    title: "Versionsverwaltung",
    to: "/settings/source-control",
    developerOnly: true,
  },
  {
    id: "source-control-writing-model",
    title: "Eigenes Modell",
    to: "/settings/source-control",
    targetId: "source-control",
    developerOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = Object.fromEntries(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item]),
) as Readonly<Record<SettingsSearchItemId, SettingsSearchItem>>;

/**
 * `id` and `title` props for the element a search item anchors to. Panels
 * spread (or pick from) this instead of restating the strings, so the catalog
 * and the rendered settings cannot drift apart.
 */
export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID[id];
  return { id: anchorId, title };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The settings pages themselves as synthetic search items, so typing a
 * navigation label finds the page even when no individual setting carries
 * that title.
 */
const SETTINGS_PAGE_SEARCH_ITEMS: ReadonlyArray<SettingsSearchItem> = (
  Object.entries(SETTINGS_SECTION_LABELS) as ReadonlyArray<[SettingsPath, string]>
).map(([path, label]) => ({
  id: path,
  title: label,
  to: path,
  searchAliases: SETTINGS_SECTION_SEARCH_ALIASES[path] ?? [],
  ...(isDeveloperSettingsPath(path) ? { developerOnly: true } : {}),
}));

function isVisible(item: SettingsSearchItem, developerMode: boolean): boolean {
  return developerMode || (item.developerOnly !== true && !isDeveloperSettingsPath(item.to));
}

export function searchSettings(
  query: string,
  options: {
    readonly developerMode?: boolean;
    readonly items?: ReadonlyArray<SettingsSearchItem>;
  } = {},
): ReadonlyArray<SettingsSearchItem> {
  const developerMode = options.developerMode ?? false;
  const items = options.items ?? SETTINGS_SEARCH_ITEMS;
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const matchesQuery = (item: SettingsSearchItem) =>
    [item.title, ...(item.searchAliases ?? [])].some((label) =>
      normalizeSearchText(label).includes(normalizedQuery),
    );

  const matches = items.filter((item) => isVisible(item, developerMode) && matchesQuery(item));
  // Page results lead, minus pages an equally titled item already represents
  // (e.g. the "Rechner" catalog entry that lands on /settings/computers).
  const pageMatches = SETTINGS_PAGE_SEARCH_ITEMS.filter(
    (page) =>
      isVisible(page, developerMode) &&
      matchesQuery(page) &&
      !matches.some(
        (item) =>
          item.to === page.to &&
          normalizeSearchText(item.title) === normalizeSearchText(page.title),
      ),
  );
  return [...pageMatches, ...matches];
}
