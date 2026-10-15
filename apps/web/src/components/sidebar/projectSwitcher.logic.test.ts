import { describe, expect, it } from "vitest";

import {
  buildProjectSwitcherEntries,
  filterProjectSwitcherEntries,
  projectFolderName,
} from "./projectSwitcher.logic";

describe("buildProjectSwitcherEntries", () => {
  it("unterscheidet „metric“ und „Metric“ über eine Meta-Zeile", () => {
    const entries = buildProjectSwitcherEntries([
      { id: "a", title: "metric", metaCandidates: ["metric", "welsch"] },
      { id: "b", title: "Metric", metaCandidates: ["Metric-Archiv", "welsch"] },
      { id: "c", title: "Light Gun Heroes", metaCandidates: ["lgh"] },
    ]);
    const [first, second, third] = entries;
    expect(first?.meta).toBe("metric");
    expect(second?.meta).toBe("Metric-Archiv");
    expect(`${first?.title}|${first?.meta}`).not.toBe(`${second?.title}|${second?.meta}`);
    expect(third?.meta).toBeNull();
  });

  it("nimmt das erste Merkmal, das alle Gleichnamigen trennt", () => {
    const entries = buildProjectSwitcherEntries([
      { id: "a", title: "metric", metaCandidates: ["metric", "welsch"] },
      { id: "b", title: "Metric", metaCandidates: ["metric", "thesen"] },
    ]);
    expect(entries.map((entry) => entry.meta)).toEqual(["welsch", "thesen"]);
  });

  it("macht auch ohne Merkmale jede Zeile eindeutig", () => {
    const entries = buildProjectSwitcherEntries([
      { id: "a", title: "metric" },
      { id: "b", title: "metric" },
    ]);
    const labels = entries.map((entry) => `${entry.title}|${entry.meta ?? ""}`);
    expect(new Set(labels).size).toBe(2);
  });
});

describe("filterProjectSwitcherEntries", () => {
  it("sucht in Name und Meta-Zeile, ohne Groß-/Kleinschreibung", () => {
    const entries = buildProjectSwitcherEntries([
      { id: "a", title: "metric", metaCandidates: ["welsch"] },
      { id: "b", title: "Metric", metaCandidates: ["thesen"] },
      { id: "c", title: "Light Gun Heroes" },
    ]);
    expect(filterProjectSwitcherEntries(entries, "METRIC").map((entry) => entry.id)).toEqual([
      "a",
      "b",
    ]);
    expect(filterProjectSwitcherEntries(entries, "thesen").map((entry) => entry.id)).toEqual([
      "b",
    ]);
    expect(filterProjectSwitcherEntries(entries, " ")).toHaveLength(3);
  });
});

describe("projectFolderName", () => {
  it("zeigt nur den Ordner, keinen Pfad", () => {
    expect(projectFolderName("/Users/michael/Light Gun Heroes/")).toBe("Light Gun Heroes");
    expect(projectFolderName("C:\\work\\metric")).toBe("metric");
    expect(projectFolderName(null)).toBeNull();
  });
});
