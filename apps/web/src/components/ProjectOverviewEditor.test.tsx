import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@workjet/contracts";
import { ProjectOverviewEditor } from "./ProjectOverviewEditor";

describe("compact project configuration", () => {
  it.each([
    {
      info: { summary: "Canonical summary", description: "Legacy description" },
      expected: "Canonical summary",
    },
    { info: { description: "Legacy description" }, expected: "Legacy description" },
    { info: { summary: "", description: "Legacy description" }, expected: "" },
  ])("loads the native summary and falls back only when it is absent", ({ info, expected }) => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewEditor
        overview={null}
        configuration={{ id: ProjectId.make("project"), title: "Project", info }}
        onSave={async () => true}
        onSaveConfiguration={async () => true}
      />,
    );
    expect(markup).toContain(`value="${expected}"`);
    if (info.summary !== undefined) expect(markup).not.toContain('value="Legacy description"');
  });
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
    expect(markup.match(/placeholder="Kennzahl in einem Satz"/g)).toHaveLength(3);
    expect(markup).not.toContain("KPI-Angaben brauchen");
    expect(markup).toContain("Git-Quelle");
    expect(markup).toContain("Webseite");
    expect(markup).toContain("Budget (Mrd.)");
    expect(markup).not.toContain("Entered metric");
    expect(markup).not.toContain("type</label>");
    expect(markup).toContain("Regeltermin Wochentag");
    expect(markup).toContain("Regeltermin-Vorbereitung");
    expect(markup).not.toContain("No meeting");
    expect(markup).toContain('value="13:00"');
    expect(markup).toContain("Keep the goal");
    expect(markup).toContain("Projekt archivieren");
    expect(markup).toContain("Abbrechen");
    expect(markup).toContain("Projekt speichern");
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
    expect(markup).toContain("Quelle fehlt");
    expect(markup).not.toContain(">analytics_not_connected<");
    expect(markup).not.toContain("KPI prompts need");
    expect(markup.match(/type="number"/g)).toHaveLength(1);
    expect(markup).toContain("Supervisor-Takt in Minuten");
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
    expect(markup).not.toContain("KPI-Angaben brauchen");
    expect(
      markup.match(/<input[^>]*disabled=""[^>]*placeholder="Kennzahl in einem Satz"/g),
    ).toHaveLength(3);
  });
});
