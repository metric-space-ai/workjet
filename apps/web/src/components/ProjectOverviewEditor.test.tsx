import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@workjet/contracts";
import { ProjectOverviewEditor } from "./ProjectOverviewEditor";

describe("compact project configuration", () => {
  it("shows one sentence per KPI without manual type, label or value controls", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewEditor
        overview={{
          websiteUrl: "https://example.org",
          slots: [{ kind: "metric", label: "Retained", value: 17, unit: "" }, null, null],
        }}
        configuration={{
          id: ProjectId.make("project"),
          title: "Project",
          info: {
            description: "A description",
            goal: "Keep the goal",
            phase: "Build",
            status: "Active",
          },
          jourFixe: { weekday: 3, time: "13:00", timezone: "Europe/Berlin" },
        }}
        onSave={async () => true}
        onSaveConfiguration={async () => true}
        onArchive={async () => true}
      />,
    );
    expect(markup.match(/placeholder="Describe the metric in one sentence"/g)).toHaveLength(3);
    expect(markup).toContain("KPI prompts need the CTOX KPI service");
    expect(markup).not.toContain("Entered metric");
    expect(markup).not.toContain("type</label>");
    expect(markup).toContain("Jour fixe weekday");
    expect(markup).toContain('value="13:00"');
    expect(markup).toContain("Keep the goal");
    expect(markup).toContain("Archive project");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Save project");
  });
  it("renders a native missing source instead of offering an entered value", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewEditor
        overview={null}
        configuration={{ id: ProjectId.make("project"), title: "Project" }}
        onSave={async () => true}
        kpis={{
          project_id: "project",
          revision: 1,
          items: [
            {
              prompt: { kpi_id: "traffic", prompt: "Count visits this week", revision: 1 },
              result: { status: "missing_source", reason_code: "analytics_not_connected" },
            },
          ],
        }}
        onSaveKpis={async () => true}
      />,
    );
    expect(markup).toContain("Count visits this week");
    expect(markup).toContain("analytics_not_connected");
    expect(markup).not.toContain("KPI prompts need");
    expect(markup).not.toContain('type="number"');
  });
  it("does not expose KPI configuration for a foreign project", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewEditor
        overview={null}
        configuration={{ id: ProjectId.make("own"), title: "Own" }}
        onSave={async () => true}
        kpis={{ project_id: "foreign", revision: 1, items: [] }}
        onSaveKpis={async () => true}
      />,
    );
    expect(markup).toContain("KPI prompts need the CTOX KPI service");
  });
});
