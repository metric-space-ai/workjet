import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { PromptedProjectKpis } from "../projectKpis";
import { ProjectKpiTile, projectKpiTileLabel } from "./ProjectKpiTile";

const kpis: PromptedProjectKpis = {
  project_id: "p1",
  revision: 2,
  items: [
    {
      prompt: { kpi_id: "kpi-1", prompt: "Weekly active users", revision: 2 },
      result: {
        status: "ready",
        snapshot: {
          project_id: "p1",
          kpi_id: "kpi-1",
          prompt_revision: 2,
          label: "Active users",
          display_value: "412",
          unit: "",
          sources: [
            { kind: "native_metric", project_id: "p1", connection_id: "c", metric_key: "u" },
          ],
          freshness: { calculated_at_ms: 1, refresh_at_ms: 2, fresh_until_ms: 3 },
        },
      },
    },
    {
      prompt: { kpi_id: "kpi-2", prompt: "Revenue this month", revision: 2 },
      result: { status: "missing_source", reason_code: "no_source" },
    },
  ],
};

const tile = (index: number, expanded: boolean, editable = true) =>
  renderToStaticMarkup(
    <ProjectKpiTile
      projectId="p1"
      index={index}
      kpis={kpis}
      expanded={expanded}
      onExpandedChange={() => {}}
      onSave={editable ? async () => true : undefined}
      onRefresh={editable ? async () => true : undefined}
    />,
  );

describe("KPI tile on the project card", () => {
  it("labels slots with the resolved label, else the KPI's sentence, never a state text", () => {
    expect(projectKpiTileLabel(kpis, "p1", 0)).toBe("Active users");
    expect(projectKpiTileLabel(kpis, "p1", 1)).toBe("Revenue this month");
    expect(projectKpiTileLabel(kpis, "p1", 2)).toBe("");
    for (const index of [0, 1, 2]) {
      const markup = tile(index, false);
      for (const state of ["nicht berechnet", "not calculated", "nicht festgelegt", "not set"])
        expect(markup).not.toContain(state);
    }
    // Defined but not calculated: only the KPI's own sentence (two lines), no „—“.
    expect(tile(1, false)).toMatch(/>Revenue this month<\/dt>/);
    expect(tile(1, false)).toContain("line-clamp-2");
    expect(tile(1, false)).not.toMatch(/>—<\/dd>/);
  });

  it("collapsed: a toggle with aria-expanded=false and an inert editor", () => {
    const markup = tile(0, false);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("412");
    expect(markup).toContain("opacity-0");
    expect(markup).toContain("inert");
    expect(markup).not.toContain("data-workjet-kpi-tile-expanded");
  });

  it("expanded in place: prompt textarea capped at 1024, status, recalculate and close", () => {
    const markup = tile(1, true);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("data-workjet-kpi-tile-expanded");
    expect(markup).toContain("absolute inset-0");
    expect(markup).not.toContain("col-span-3");
    expect(markup).not.toContain("Status:");
    expect(markup).toContain('maxLength="1024"');
    expect(markup).toContain("Revenue this month");
    expect(markup).toContain('data-workjet-action="project.kpis.refresh:p1"');
    expect(markup).toMatch(/Quelle fehlt|Source missing/);
    expect(markup).toMatch(/Schließen|Close/);
    expect(markup).not.toContain('role="dialog"');
  });

  it("without a save handler the tile is read-only", () => {
    const markup = tile(0, false, false);
    expect(markup).not.toContain("aria-expanded");
    expect(markup).not.toContain("textarea");
  });
});
