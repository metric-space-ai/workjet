import { describe, expect, it } from "vite-plus/test";

import {
  searchableSetting,
  searchSettings,
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
  settingsPageForPath,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  { id: "word-wrap", title: "Word wrap", to: "/settings/general" },
  { id: "network-access", title: "Network access", to: "/settings/computers" },
  { id: "provider-updates", title: "Update checks", to: "/settings/general" },
  { id: "automatic-updates", title: "Automatic updates", to: "/settings/general" },
];

const ids = (query: string, developerMode = false) =>
  searchSettings(query, { developerMode }).map((item) => item.id);

describe("searchSettings", () => {
  it("matches setting titles and the pages themselves", () => {
    expect(searchSettings("word", { items: ITEMS }).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", { items: ITEMS }).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(searchSettings("connections", { items: ITEMS })).toEqual([]);
    expect(searchSettings("instances", { items: ITEMS }).map((item) => item.to)).toEqual([
      "/settings/business-os",
    ]);
  });

  it("keeps catalog order and ignores empty queries", () => {
    expect(searchSettings("update", { items: ITEMS }).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
    expect(searchSettings("   ")).toEqual([]);
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("finds Modelle for „modell“ (#603)", () => {
    const results = searchSettings("modell");
    expect(results.map((item) => item.title)).toContain("Modelle");
    expect(results.find((item) => item.title === "Modelle")?.to).toBe("/settings/models");
  });

  it("finds Presets under the old name Lumas (15.10.)", () => {
    expect(searchSettings("lumas").map((item) => item.title)).toContain("Presets");
    expect(searchSettings("luma").map((item) => item.to)).toContain("/settings/workjet");
  });

  it("finds working copies on Rechner, only in developer mode (15.10.)", () => {
    expect(searchSettings("arbeitskopie").map((item) => item.id)).not.toContain(
      "project-working-copies",
    );
    expect(
      searchSettings("arbeitskopie", { developerMode: true }).find(
        (item) => item.id === "project-working-copies",
      )?.to,
    ).toBe("/settings/computers");
  });

  it("offers no hits on hidden settings without developer mode (#550)", () => {
    for (const query of [
      "plan-modus",
      "token-streaming",
      "diagnose",
      "harnesses",
      "tastenkürzel",
    ]) {
      expect(ids(query)).toEqual([]);
      expect(ids(query, true).length).toBeGreaterThan(0);
    }
    expect(ids("modell")).not.toContain("source-control-writing-model");
    expect(ids("modell", true)).toContain("source-control-writing-model");
  });

  it("drops the removed theme and font settings (#553)", () => {
    for (const query of ["glas", "kantenglättung", "oberflächenschrift", "terminal-schrift"]) {
      expect(searchSettings(query, { developerMode: true })).toEqual([]);
    }
    expect(ids("dunkel")).toEqual(["color-scheme"]);
    expect(ids("schriftgröße")).toEqual(["font-size"]);
  });

  it("has no Textmodell setting any more (Michael, 15.10.)", () => {
    expect(searchSettings("textmodell")).toEqual([]);
  });

  it("keeps catalog result ids unique and anchor props from the catalog", () => {
    const allIds = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(searchableSetting("archive")).toEqual({
      id: "archive",
      title: "Archivierte Unterhaltungen",
    });
  });

  it("finds German page labels and the old vocabulary", () => {
    for (const [query, path] of [
      ["Allgemein", "/settings/general"],
      ["Darstellung", "/settings/general"],
      ["Instanzen", "/settings/business-os"],
      ["Computers", "/settings/computers"],
      ["Worker-Presets", "/settings/workjet"],
      ["Sprachausgabe", "/settings/speech"],
      ["Archiv", "/settings/archived"],
      ["Verbrauch", "/settings/usage"],
    ] as const) {
      expect(searchSettings(query).map((item) => item.to)).toContain(path);
    }
  });

  it("maps subpages to their parent page", () => {
    expect(settingsPageForPath("/settings/prompts")).toBe("/settings/workjet");
    expect(settingsPageForPath("/settings/usage")).toBe("/settings/models");
    expect(settingsPageForPath("/settings/projects/abc")).toBeNull();
    expect(settingsPageForPath("/settings/general")).toBe("/settings/general");
    expect(SETTINGS_SECTION_LABELS["/settings/business-os"]).toBe("Instanz");
  });
});
