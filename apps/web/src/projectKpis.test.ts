import { describe, expect, it } from "vite-plus/test";
import {
  projectKpiPresentation,
  projectKpiPromptInputs,
  type ProjectKpiRecord,
} from "./projectKpis";

const record: ProjectKpiRecord = {
  prompt: { kpi_id: "open-prs", prompt: "Count open project PRs", revision: 2 },
  result: {
    status: "ready",
    snapshot: {
      project_id: "project",
      kpi_id: "open-prs",
      prompt_revision: 2,
      label: "Open PRs",
      display_value: "7",
      unit: "",
      sources: [
        {
          kind: "github_metric",
          project_id: "project",
          connection_id: "github",
          metric_key: "prs.open",
        },
      ],
      freshness: {
        calculated_at_ms: 1791399600000,
        refresh_at_ms: 1791400200000,
        fresh_until_ms: 1791400800000,
      },
    },
  },
};

describe("native project KPI presentation", () => {
  it("renders only the native display value, source and calculation time", () => {
    expect(projectKpiPresentation(record, "project", 1)).toMatchObject({
      label: "Open PRs",
      value: "7",
      source: "GitHub",
      status: "ready",
      calculatedAt: 1791399600000,
    });
  });
  it("does not reuse a result after its prompt changes", () => {
    expect(projectKpiPresentation(record, "project", 1, "Count merged PRs")).toMatchObject({
      value: "—",
      status: "changed",
      calculatedAt: null,
    });
  });
  it.each(["missing_source", "failed", "resolving"] as const)(
    "hides a forbidden snapshot for %s",
    (status) => {
      expect(
        projectKpiPresentation(
          { ...record, result: { ...record.result, status, reason_code: "source_unavailable" } },
          "project",
          1,
        ),
      ).toMatchObject({ value: "—", status, detail: "source_unavailable", calculatedAt: null });
    },
  );
  it("retains a stale snapshot with its native reason", () => {
    expect(
      projectKpiPresentation(
        {
          ...record,
          result: { ...record.result, status: "stale", reason_code: "refresh_pending" },
        },
        "project",
        1,
      ),
    ).toMatchObject({ value: "7", status: "stale", detail: "refresh_pending" });
  });
  it("rejects wrong-project, old-revision, missing-source and invalid-time snapshots", () => {
    const snapshot = record.result.snapshot!;
    for (const change of [
      { project_id: "foreign" },
      { kpi_id: "other" },
      { prompt_revision: 1 },
      { sources: [] },
      { sources: [{ ...snapshot.sources[0]!, project_id: "foreign" }] },
      { freshness: { ...snapshot.freshness, calculated_at_ms: Infinity } },
    ])
      expect(
        projectKpiPresentation(
          { ...record, result: { status: "ready", snapshot: { ...snapshot, ...change } } },
          "project",
          1,
        ),
      ).toMatchObject({ value: "—", status: "failed", detail: "invalid_snapshot" });
  });
  it("does not invent a number when no KPI has been configured", () => {
    expect(projectKpiPresentation(undefined, "project", 3)).toMatchObject({
      label: "KPI 3",
      value: "—",
      status: "unconfigured",
    });
  });
});

describe("native KPI prompt changes", () => {
  const kpis = {
    project_id: "project",
    revision: 4,
    items: [{ ...record, prompt: { ...record.prompt, kpi_id: "kpi-2" } }],
  };
  it("retains IDs, avoids collisions and drops empty sentences", () => {
    expect(projectKpiPromptInputs(["  First  ", "Second", " "], kpis)).toEqual([
      { kpi_id: "kpi-2", prompt: "First" },
      { kpi_id: "kpi-2-2", prompt: "Second" },
    ]);
    expect(projectKpiPromptInputs(["", "", ""], kpis)).toEqual([]);
  });
});
