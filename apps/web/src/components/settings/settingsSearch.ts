export type SettingsPath =
  | "/settings/business-os"
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/harnesses"
  | "/settings/models"
  | "/settings/speech"
  | "/settings/computers"
  | "/settings/workjet"
  | "/settings/projects"
  | "/settings/source-control"
  | "/settings/diagnostics"
  | "/settings/archived"
  | "/settings/usage";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly searchAliases?: ReadonlyArray<string>;
}

/**
 * Section labels in sidebar order. The sidebar nav and the search-result
 * subtitles both render from this record, so each label exists once.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/business-os": "Instanzen",
  "/settings/general": "Allgemein",
  "/settings/appearance": "Darstellung",
  "/settings/keybindings": "Tastenkürzel",
  "/settings/harnesses": "Harnesses",
  "/settings/models": "Modelle",
  "/settings/speech": "Sprachausgabe",
  "/settings/computers": "Rechner",
  // Worker composition sits beside the pages it references (Models,
  // Computers, Harnesses); Source Control follows the workflow pages.
  "/settings/workjet": "Lumas",
  "/settings/projects": "Projekte",
  "/settings/source-control": "Versionsverwaltung",
  "/settings/diagnostics": "Diagnose",
  "/settings/archived": "Archiv",
  "/settings/usage": "Verbrauch",
};

const SETTINGS_SECTION_SEARCH_ALIASES: Partial<Record<SettingsPath, readonly string[]>> = {
  "/settings/business-os": ["Instances"],
  "/settings/general": ["General"],
  "/settings/appearance": ["Appearance"],
  "/settings/models": ["Models"],
  "/settings/speech": ["Speech", "Diktat"],
  "/settings/computers": ["Computers"],
  "/settings/source-control": ["Source Control"],
  "/settings/diagnostics": ["Diagnostics"],
  "/settings/archived": ["Archive"],
  "/settings/usage": ["Usage", "Kosten", "Tokens"],
};

/**
 * Every searchable setting, in result order. This catalog is the single
 * source of truth for anchor ids and visible titles: panels render both via
 * `searchableSetting`, so a retitle (or, later, a translation pass) happens
 * here once instead of separately in the panel and the index.
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "posthog-consent",
    title: "Nutzungsdaten senden",
    to: "/settings/general",
    searchAliases: ["telemetry", "privacy", "consent", "us.i.posthog.com"],
  },
  {
    id: "color-scheme",
    title: "Farbschema",
    to: "/settings/appearance",
    // The scheme tiles sit at the top of the Appearance section.
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "Themen",
    to: "/settings/appearance",
    // Theme cards live directly under the scheme tiles; the section is the
    // stable scroll destination for both.
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glas",
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: "Umgebungskennung",
    to: "/settings/appearance",
    // The setting is stage-dependent, so its parent section is the stable destination.
    targetId: "appearance",
  },
  {
    id: "interface-font",
    title: "Oberflächenschrift",
    to: "/settings/appearance",
  },
  {
    id: "prompt-font",
    title: "Prompt-Schrift",
    to: "/settings/appearance",
  },
  {
    id: "code-font",
    title: "Code-Schrift",
    to: "/settings/appearance",
  },
  {
    id: "terminal-font",
    title: "Terminal-Schrift",
    to: "/settings/appearance",
  },
  {
    id: "font-smoothing",
    title: "Kantenglättung",
    to: "/settings/appearance",
  },
  {
    id: "word-wrap",
    title: "Zeilenumbruch",
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    title: "Projekte gruppieren",
    to: "/settings/general",
  },
  {
    id: "auto-settle-inactive-threads",
    title: "Inaktive ablegen",
    to: "/settings/general",
  },
  {
    id: "auto-settle-merged-threads",
    title: "Zusammengeführte ablegen",
    to: "/settings/general",
  },
  {
    id: "time-format",
    title: "Zeitformat",
    to: "/settings/general",
  },
  {
    id: "calendar-week-start",
    title: "Wochenbeginn",
    to: "/settings/general",
  },
  {
    id: "hide-whitespace-changes",
    title: "Leerraum ausblenden",
    to: "/settings/general",
  },
  {
    id: "provider-update-checks",
    title: "Update-Prüfung",
    to: "/settings/general",
  },
  {
    id: "new-threads",
    title: "Neue Unterhaltungen",
    to: "/settings/general",
  },
  {
    id: "start-from-origin",
    title: "Von origin starten",
    to: "/settings/general",
    targetId: "new-threads",
  },
  {
    id: "add-project-starts-in",
    title: "Projektordner",
    to: "/settings/general",
  },
  {
    id: "archive-confirmation",
    title: "Archivieren bestätigen",
    to: "/settings/general",
  },
  {
    id: "delete-confirmation",
    title: "Löschen bestätigen",
    to: "/settings/general",
  },
  {
    id: "text-generation-model",
    title: "Textmodell",
    to: "/settings/general",
  },
  {
    id: "diagnostics",
    title: "Diagnose",
    to: "/settings/general",
  },
  {
    id: "legacy-plan-mode",
    title: "Plan-Modus",
    to: "/settings/general",
  },
  {
    id: "legacy-token-streaming",
    title: "Token-Streaming",
    to: "/settings/general",
  },
  {
    id: "harnesses",
    title: "Harnesses",
    to: "/settings/harnesses",
  },
  {
    id: "import-sessions",
    title: "Sitzungen importieren",
    to: "/settings/harnesses",
    searchAliases: ["import", "history", "histories"],
  },
  {
    id: "source-control",
    title: "Versionsverwaltung",
    to: "/settings/source-control",
  },
  {
    id: "workjet-workers",
    // Match the page title to keep one result, while preserving old search vocabulary.
    title: "Lumas",
    searchAliases: ["worker", "workers", "agent", "agents"],
    to: "/settings/workjet",
  },
  {
    id: "workjet-computers",
    title: "Rechner",
    searchAliases: ["computers", "computer"],
    // Computers is a top-level settings page of its own.
    to: "/settings/computers",
  },
  {
    id: "workjet-provider-accounts",
    title: "LLM-Anbieter",
    // LLM accounts live on the Models page. Harnesses are CLI runtimes and
    // have their own page — the two were merged once and became impossible to
    // find, because "Providers" read as one thing and held two.
    to: "/settings/models",
  },
  {
    id: "workjet-provider-pools",
    title: "Gateway-Pools",
    // Directly under the account list, on the same Models page.
    to: "/settings/models",
  },
  {
    id: "workjet-llm-routes",
    title: "LLM-Routen",
    // Routes live on the Models page, beside the accounts they reference.
    to: "/settings/models",
  },
  {
    id: "workjet-organigram",
    title: "Organigramm",
    to: "/settings/workjet",
  },
  {
    id: "workjet-prompt",
    title: "Prompt",
    to: "/settings/workjet",
  },
  {
    id: "workjet-telemetry",
    title: "Telemetrie",
    to: "/settings/workjet",
  },
  {
    id: "workjet-execution",
    title: "Ausführung",
    to: "/settings/workjet",
  },
  {
    id: "automatic-worktree-storage",
    title: "Arbeitskopien-Speicher",
    to: "/settings/workjet",
    targetId: "workjet-execution",
  },
  {
    id: "greppy-runtime",
    title: "Code-Suche",
    to: "/settings/workjet",
    searchAliases: ["greppy", "greppy-laufzeit"],
  },
  {
    id: "archive",
    title: "Archivierte Unterhaltungen",
    to: "/settings/archived",
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
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The settings pages themselves as synthetic search items, so typing a
 * sidebar label ("Computers", "Diagnostics") finds the page even when no
 * individual setting carries that title.
 */
const SETTINGS_PAGE_SEARCH_ITEMS: ReadonlyArray<SettingsSearchItem> = (
  Object.entries(SETTINGS_SECTION_LABELS) as ReadonlyArray<[SettingsPath, string]>
)
  .filter(([path]) => path !== "/settings/keybindings")
  .map(([path, label]) => ({
    id: path,
    title: label,
    to: path,
    searchAliases: SETTINGS_SECTION_SEARCH_ALIASES[path] ?? [],
  }));

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  const matches = items.filter(
    (item) =>
      item.to !== "/settings/keybindings" &&
      [item.title, ...(item.searchAliases ?? [])].some((label) =>
        normalizeSearchText(label).includes(normalizedQuery),
      ),
  );
  // Page results lead, minus pages an equally titled item already represents
  // (e.g. the "Computers" catalog entry that lands on /settings/computers).
  const pageMatches = SETTINGS_PAGE_SEARCH_ITEMS.filter(
    (page) =>
      [page.title, ...(page.searchAliases ?? [])].some((label) =>
        normalizeSearchText(label).includes(normalizedQuery),
      ) &&
      !matches.some(
        (item) =>
          item.to === page.to &&
          normalizeSearchText(item.title) === normalizeSearchText(page.title),
      ),
  );
  return [...pageMatches, ...matches];
}
