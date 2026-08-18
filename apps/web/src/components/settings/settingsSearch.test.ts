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
    to: "/settings/connections",
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
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
  it("matches only setting titles", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS)).toEqual([]);
    expect(searchSettings("claude", ITEMS)).toEqual([]);
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

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchableSetting("word-wrap")).toEqual({ id: "word-wrap", title: "Word wrap" });
    expect(searchableSetting("archive")).toEqual({ id: "archive", title: "Archived threads" });
  });

  it("registers the Workjet catalog areas before Greppy runtime", () => {
    expect(searchSettings("workers")).toEqual([
      { id: "workjet-workers", title: "Workers", to: "/settings/workjet" },
    ]);
    expect(searchSettings("provider accounts")).toEqual([
      { id: "workjet-provider-accounts", title: "Provider accounts", to: "/settings/workjet" },
    ]);
    expect(searchSettings("llm routes")).toEqual([
      { id: "workjet-llm-routes", title: "LLM routes", to: "/settings/workjet" },
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
    expect(workjetIds).toEqual([
      "workjet-workers",
      "workjet-computers",
      "workjet-provider-accounts",
      "workjet-llm-routes",
      "workjet-prompt",
      "workjet-telemetry",
      "workjet-execution",
      "automatic-worktree-storage",
      "workjet-capabilities",
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
