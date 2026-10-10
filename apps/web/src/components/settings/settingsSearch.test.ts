import { describe, expect, it } from "vite-plus/test";

import {
  searchableSetting,
  searchSettings,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/computers",
  },
  {
    id: "harnesses",
    title: "Harnesses",
    to: "/settings/harnesses",
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("matches setting titles and the pages themselves", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    // A sidebar label is findable even when no individual setting carries it.
    expect(searchSettings("connections", ITEMS)).toEqual([]);
    expect(searchSettings("instances", ITEMS)).toEqual([
      {
        id: "/settings/business-os",
        title: "Instanzen",
        to: "/settings/business-os",
        searchAliases: ["Instances"],
      },
    ]);
    expect(searchSettings("claude", ITEMS)).toEqual([]);
  });

  it("does not repeat a page whose title an item already carries", () => {
    // "Harnesses" is both the sidebar label and a catalog item landing on the
    // same page; one result, not two identical rows.
    expect(searchSettings("harnesses", ITEMS)).toEqual([
      { id: "harnesses", title: "Harnesses", to: "/settings/harnesses" },
    ]);
    // "Computers" likewise resolves to the single catalog entry for the page.
    expect(searchSettings("computers").map((item) => item.id)).toEqual(["workjet-computers"]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("keeps catalog order for multiple title matches", () => {
    expect(searchSettings("update", ITEMS).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("finds session import and links to its section on the Harnesses page", () => {
    for (const query of ["import", "import sessions", "histories"]) {
      expect(searchSettings(query)).toEqual([
        {
          id: "import-sessions",
          title: "Import sessions",
          to: "/settings/harnesses",
          searchAliases: ["import", "history", "histories"],
        },
      ]);
    }
    expect(searchableSetting("import-sessions")).toEqual({
      id: "import-sessions",
      title: "Import sessions",
    });
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds German navigation labels and keeps the old English search vocabulary", () => {
    for (const [german, english, path] of [
      ["Allgemein", "General", "/settings/general"],
      ["Darstellung", "Appearance", "/settings/appearance"],
      ["Rechner", "Computers", "/settings/computers"],
      ["Sprache", "Speech", "/settings/speech"],
    ]) {
      expect(searchSettings(german).map((item) => item.to)).toContain(path);
      expect(searchSettings(english).map((item) => item.to)).toContain(path);
    }
  });

  it("keeps Business OS first and removes Connections from visible settings", async () => {
    const { SETTINGS_SECTION_LABELS } = await import("./settingsSearch");
    expect(Object.keys(SETTINGS_SECTION_LABELS)[0]).toBe("/settings/business-os");
    expect(Object.values(SETTINGS_SECTION_LABELS)).not.toContain("Connections");
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchableSetting("word-wrap")).toEqual({ id: "word-wrap", title: "Word wrap" });
    expect(searchableSetting("archive")).toEqual({ id: "archive", title: "Archived threads" });
  });

  it("registers the Workjet catalog areas before Greppy runtime", () => {
    // Both the current label and legacy vocabulary resolve to one catalog item.
    for (const query of ["worker", "Luma", "Lumas"]) {
      expect(searchSettings(query)).toEqual([
        {
          id: "workjet-workers",
          title: "Lumas",
          to: "/settings/workjet",
          searchAliases: ["worker", "workers", "agent", "agents"],
        },
      ]);
    }
    expect(searchSettings("llm providers")).toEqual([
      { id: "workjet-provider-accounts", title: "LLM providers", to: "/settings/models" },
    ]);
    expect(searchSettings("llm routes")).toEqual([
      { id: "workjet-llm-routes", title: "LLM routes", to: "/settings/models" },
    ]);
    expect(searchSettings("greppy runtime")).toEqual([
      {
        id: "greppy-runtime",
        title: "Greppy Runtime",
        to: "/settings/workjet",
      },
    ]);
    expect(searchSettings("worktree storage")).toEqual([
      {
        id: "automatic-worktree-storage",
        title: "Automatic worktree storage",
        to: "/settings/workjet",
        targetId: "workjet-execution",
      },
    ]);

    const workjetIds = SETTINGS_SEARCH_ITEMS.filter((item) => item.to === "/settings/workjet").map(
      (item) => item.id,
    );
    // Computers is its own page, provider accounts and LLM routes live on
    // /settings/models, and capabilities are toggled in the worker editor —
    // only the five tabs plus their nested anchors resolve to the Worker page.
    expect(workjetIds).toEqual([
      "workjet-workers",
      "workjet-organigram",
      "workjet-prompt",
      "workjet-telemetry",
      "workjet-execution",
      "automatic-worktree-storage",
      "greppy-runtime",
    ]);
  });

  it("routes appearance settings to their current section", () => {
    expect(searchSettings("theme")[0]).toMatchObject({
      id: "theme",
      to: "/settings/appearance",
    });
    expect(searchSettings("word wrap")[0]).toMatchObject({
      id: "word-wrap",
      to: "/settings/appearance",
    });
    expect(searchSettings("environment identification")[0]).toMatchObject({
      id: "environment-identification",
      to: "/settings/appearance",
      targetId: "appearance",
    });
  });
});
