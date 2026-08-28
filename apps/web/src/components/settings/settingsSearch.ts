export type SettingsPath =
  | "/settings/business-os"
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/harnesses"
  | "/settings/models"
  | "/settings/computers"
  | "/settings/workjet"
  | "/settings/source-control"
  | "/settings/diagnostics"
  | "/settings/archived";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
}

/**
 * Section labels in sidebar order. The sidebar nav and the search-result
 * subtitles both render from this record, so each label exists once.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/business-os": "Business OS",
  "/settings/general": "General",
  "/settings/appearance": "Appearance",
  "/settings/keybindings": "Keybindings",
  "/settings/harnesses": "Harnesses",
  "/settings/models": "Models",
  "/settings/computers": "Computers",
  // Worker composition sits beside the pages it references (Models,
  // Computers, Harnesses); Source Control follows the workflow pages.
  "/settings/workjet": "Worker",
  "/settings/source-control": "Source Control",
  "/settings/diagnostics": "Diagnostics",
  "/settings/archived": "Archive",
};

/**
 * Every searchable setting, in result order. This catalog is the single
 * source of truth for anchor ids and visible titles: panels render both via
 * `searchableSetting`, so a retitle (or, later, a translation pass) happens
 * here once instead of separately in the panel and the index.
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "color-scheme",
    title: "Color scheme",
    to: "/settings/appearance",
    // The scheme tiles sit at the top of the Appearance section.
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "Themes",
    to: "/settings/appearance",
    // Theme cards live directly under the scheme tiles; the section is the
    // stable scroll destination for both.
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glass opacity",
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: "Environment identification",
    to: "/settings/appearance",
    // The setting is stage-dependent, so its parent section is the stable destination.
    targetId: "appearance",
  },
  {
    id: "interface-font",
    title: "Interface font",
    to: "/settings/appearance",
  },
  {
    id: "prompt-font",
    title: "Prompt font",
    to: "/settings/appearance",
  },
  {
    id: "code-font",
    title: "Code font",
    to: "/settings/appearance",
  },
  {
    id: "terminal-font",
    title: "Terminal font",
    to: "/settings/appearance",
  },
  {
    id: "font-smoothing",
    title: "Font smoothing",
    to: "/settings/appearance",
  },
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    title: "Project grouping",
    to: "/settings/general",
  },
  {
    id: "auto-settle-inactive-threads",
    title: "Auto-settle inactive threads",
    to: "/settings/general",
  },
  {
    id: "auto-settle-merged-threads",
    title: "Auto-settle merged threads",
    to: "/settings/general",
  },
  {
    id: "time-format",
    title: "Time format",
    to: "/settings/general",
  },
  {
    id: "hide-whitespace-changes",
    title: "Hide whitespace changes",
    to: "/settings/general",
  },
  {
    id: "provider-update-checks",
    title: "Provider update checks",
    to: "/settings/general",
  },
  {
    id: "new-threads",
    title: "New threads",
    to: "/settings/general",
  },
  {
    id: "start-from-origin",
    title: "Start from origin",
    to: "/settings/general",
    targetId: "new-threads",
  },
  {
    id: "add-project-starts-in",
    title: "Add project starts in",
    to: "/settings/general",
  },
  {
    id: "archive-confirmation",
    title: "Archive confirmation",
    to: "/settings/general",
  },
  {
    id: "delete-confirmation",
    title: "Delete confirmation",
    to: "/settings/general",
  },
  {
    id: "text-generation-model",
    title: "Text generation model",
    to: "/settings/general",
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    to: "/settings/general",
  },
  {
    id: "legacy-plan-mode",
    title: "Plan mode (legacy)",
    to: "/settings/general",
  },
  {
    id: "legacy-token-streaming",
    title: "Stream token by token (legacy)",
    to: "/settings/general",
  },
  {
    id: "legacy-sidebar",
    title: "Sidebar (legacy)",
    to: "/settings/general",
  },
  {
    id: "keybindings",
    title: "Keybindings",
    to: "/settings/keybindings",
  },
  {
    id: "harnesses",
    title: "Harnesses",
    to: "/settings/harnesses",
  },
  {
    id: "source-control",
    title: "Source control",
    to: "/settings/source-control",
  },
  {
    id: "workjet-workers",
    // Singular on purpose: it must title-match the page entry so the search
    // dedupe collapses both into one result (Befund K-A12).
    title: "Worker",
    to: "/settings/workjet",
  },
  {
    id: "workjet-computers",
    title: "Computers",
    // Computers is a top-level settings page of its own.
    to: "/settings/computers",
  },
  {
    id: "workjet-provider-accounts",
    title: "LLM providers",
    // LLM accounts live on the Models page. Harnesses are CLI runtimes and
    // have their own page — the two were merged once and became impossible to
    // find, because "Providers" read as one thing and held two.
    to: "/settings/models",
  },
  {
    id: "workjet-provider-pools",
    title: "Gateway pools",
    // Directly under the account list, on the same Models page.
    to: "/settings/models",
  },
  {
    id: "workjet-llm-routes",
    title: "LLM routes",
    // Routes live on the Models page, beside the accounts they reference.
    to: "/settings/models",
  },
  {
    id: "workjet-organigram",
    title: "Organigram",
    to: "/settings/workjet",
  },
  {
    id: "workjet-prompt",
    title: "Prompt",
    to: "/settings/workjet",
  },
  {
    id: "workjet-telemetry",
    title: "Telemetry",
    to: "/settings/workjet",
  },
  {
    id: "workjet-execution",
    title: "Execution",
    to: "/settings/workjet",
  },
  {
    id: "automatic-worktree-storage",
    title: "Automatic worktree storage",
    to: "/settings/workjet",
    targetId: "workjet-execution",
  },
  {
    id: "greppy-runtime",
    title: "Greppy Runtime",
    to: "/settings/workjet",
  },
  {
    id: "remote-environments",
    title: "Remote environments",
    // Paired and removed on the Computers page, beside the computers that
    // reference them. There is no second visible Connections category.
    to: "/settings/computers",
  },
  {
    id: "archive",
    title: "Archived threads",
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
).map(([path, label]) => ({ id: path, title: label, to: path }));

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  const matches = items.filter((item) => normalizeSearchText(item.title).includes(normalizedQuery));
  // Page results lead, minus pages an equally titled item already represents
  // (e.g. the "Computers" catalog entry that lands on /settings/computers).
  const pageMatches = SETTINGS_PAGE_SEARCH_ITEMS.filter(
    (page) =>
      normalizeSearchText(page.title).includes(normalizedQuery) &&
      !matches.some(
        (item) =>
          item.to === page.to &&
          normalizeSearchText(item.title) === normalizeSearchText(page.title),
      ),
  );
  return [...pageMatches, ...matches];
}
