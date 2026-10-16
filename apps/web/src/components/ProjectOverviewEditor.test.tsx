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
    expect(markup).toContain("Repository");
    expect(markup).not.toContain("Git-Quelle");
    expect(markup).toContain("Webseite");
    expect(markup).toContain("Token-Budget");
    expect(markup).toContain("Mrd.");
    expect(markup).toContain('placeholder="kein Limit"');
    expect(markup).toContain("Regeltermin Zeitzone");
    expect(markup).not.toContain("Regeltermin-Zyklus");
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
  it("shows the prompt as editable text and the Supervisor-resolved label with its value", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewEditor
        overview={null}
        configuration={{ id: ProjectId.make("project"), title: "Project" }}
        onSave={async () => true}
        kpis={{
          project_id: "project",
          revision: 2,
          items: [
            {
              prompt: { kpi_id: "kpi-1", prompt: "Steam wishlists in total", revision: 2 },
              result: {
                status: "ready",
                snapshot: {
                  project_id: "project",
                  kpi_id: "kpi-1",
                  prompt_revision: 2,
                  label: "Wishlists",
                  display_value: "1.204",
                  unit: "",
                  sources: [
                    {
                      kind: "connected_metric",
                      project_id: "project",
                      connection_id: "steam",
                      metric_key: "wishlists",
                    },
                  ],
                  freshness: { calculated_at_ms: 1, refresh_at_ms: 2, fresh_until_ms: 3 },
                },
              },
            },
          ],
        }}
        onSaveKpis={async () => true}
      />,
    );
    expect(markup.match(/<textarea[^>]*maxLength="1024"/g)).toHaveLength(3);
    expect(markup).toContain("Steam wishlists in total</textarea>");
    expect(markup).toContain("Wishlists: </span>");
    expect(markup).toContain("1.204");
  });
  it("says so when the KPIs could not be loaded", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewEditor
        overview={null}
        configuration={{ id: ProjectId.make("project"), title: "Project" }}
        onSave={async () => true}
        onSaveKpis={async () => true}
        kpisLoadFailed
      />,
    );
    expect(markup).toContain("Kennzahlen nicht geladen");
    expect(markup.match(/<textarea[^>]*disabled=""/g)).toHaveLength(3);
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
      markup.match(/<textarea[^>]*disabled=""[^>]*placeholder="Kennzahl in einem Satz"/g),
    ).toHaveLength(3);
  });
});

describe("failed card save", () => {
  it("puts the saved value back and keeps the rejected one for retry", async () => {
    const { failedCardSave } = await import("./ProjectOverviewEditor");
    const saved = {
      title: "kunstmen.com",
      websiteUrl: null,
      repositoryUrl: null,
      jourFixe: { weekday: 2, time: "14:00", timezone: "Europe/Berlin" },
    };
    const next = { ...saved, jourFixe: { ...saved.jourFixe, time: "15:30" } };
    const outcome = failedCardSave(saved, next);
    expect(outcome.draft.jourFixe?.time).toBe("14:00");
    expect(outcome.retry.jourFixe?.time).toBe("15:30");
    expect(outcome.message).toContain("Nicht gespeichert");
  });
});

describe("card time options", () => {
  it("labels times as 24 h in German and follows the English locale", async () => {
    const { cardTimeOptions } = await import("./ProjectOverviewEditor");
    const de = cardTimeOptions("14:05", "de-DE");
    expect(de.find((option) => option.value === "14:00")?.label).toBe("14:00");
    expect(de.some((option) => option.value === "14:05")).toBe(true);
    expect(de).toHaveLength(97);
    expect(cardTimeOptions(null, "en-US").find((o) => o.value === "14:00")?.label).toMatch(/PM/);
  });
});

describe("card back configuration editor", () => {
  it("renders labelled fields that save instantly, without Speichern/Abbrechen", async () => {
    const { ProjectCardConfigEditor } = await import("./ProjectOverviewEditor");
    const markup = renderToStaticMarkup(
      <ProjectCardConfigEditor
        title="molecularity"
        websiteUrl="https://molecularity.example"
        repositoryUrl="https://github.com/metric-space-ai/molecularity"
        jourFixe={{ weekday: 2, time: "10:00", timezone: "Europe/Berlin" }}
        canEditTitle
        onSave={async () => true}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('data-workjet-project-card-config=""');
    for (const label of ["Name", "Webseite", "Repository", "Regeltermin", "Uhrzeit"])
      expect(markup).toContain(label);
    expect(markup).toContain('value="molecularity"');
    expect(markup).toContain('value="https://molecularity.example"');
    expect(markup).toContain('value="https://github.com/metric-space-ai/molecularity"');
    expect(markup).toContain("10:00");
    expect(markup).toContain('data-option="2">Dienstag</span>');
    expect(markup).toContain("Kein Termin");
    expect(markup).not.toContain("Speichern");
    expect(markup).not.toContain("Abbrechen");
    expect(markup).not.toContain('type="time"');
    for (const field of ["-name", "-website", "-repository"])
      expect(markup).toMatch(new RegExp(`<label for="[^"]*${field}"`));
    expect(markup).not.toContain("KPI");
    expect(markup).not.toContain("Supervisor");
  });
  it("locks the name without the instance save path", async () => {
    const { ProjectCardConfigEditor } = await import("./ProjectOverviewEditor");
    const markup = renderToStaticMarkup(
      <ProjectCardConfigEditor
        title="kunstmen.com"
        websiteUrl={null}
        repositoryUrl={null}
        jourFixe={null}
        onSave={async () => true}
        onCancel={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Projektname"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("Kein Termin");
  });
});

describe("card configuration patch", () => {
  const saved = {
    title: "ctox.dev",
    websiteUrl: "https://ctox.dev",
    repositoryUrl: "https://github.com/mkh-welsch/ctox-dev",
    jourFixe: { weekday: 1, time: "13:00", timezone: "Europe/Berlin" },
  };
  it("sends only the name when only the name changed", async () => {
    const { projectCardConfigurationPatch } = await import("./ProjectOverviewEditor");
    const patch = projectCardConfigurationPatch(saved, { ...saved, title: " ctox " });
    expect(patch).toEqual({ title: "ctox" });
    for (const key of ["repoUrl", "publicUrl", "info", "description", "jourFixe"])
      expect(patch).not.toHaveProperty(key);
  });
  it("sends an explicit null only for a field the user emptied", async () => {
    const { projectCardConfigurationPatch } = await import("./ProjectOverviewEditor");
    expect(projectCardConfigurationPatch(saved, { ...saved, websiteUrl: "  " })).toEqual({
      title: "ctox.dev",
      publicUrl: null,
    });
    const empty = { ...saved, websiteUrl: null, repositoryUrl: null };
    expect(projectCardConfigurationPatch(empty, { ...empty, jourFixe: null })).toEqual({
      title: "ctox.dev",
      jourFixe: null,
    });
  });
  it("proposes the folder's repository as a chip only while the field is empty", async () => {
    const { ProjectCardConfigContext, ProjectCardConfigEditor } =
      await import("./ProjectOverviewEditor");
    const render = (repositoryUrl: string | null) =>
      renderToStaticMarkup(
        <ProjectCardConfigContext.Provider
          value={{ repositorySuggestion: "https://github.com/metric-space-ai/greppy" }}
        >
          <ProjectCardConfigEditor
            title="greppy.xyz"
            websiteUrl={null}
            repositoryUrl={repositoryUrl}
            jourFixe={null}
            canEditTitle
            onSave={async () => true}
            onCancel={() => {}}
          />
        </ProjectCardConfigContext.Provider>,
      );
    const markup = render(null);
    expect(markup).toContain('data-workjet-action="project.card.config.repo-suggestion"');
    expect(markup).toContain("Repository übernehmen");
    expect(markup).toContain("github.com/metric-space-ai/greppy");
    // Proposed, not written: the field itself stays empty.
    expect(markup).not.toContain('value="https://github.com/metric-space-ai/greppy"');
    expect(render("https://github.com/x/y")).not.toContain("Repository übernehmen");
  });
});

describe("card editor save feedback (N8)", () => {
  it("shows no saving or saved text; undo stays only for 5 s", async () => {
    const { CARD_UNDO_MS, ProjectCardConfigEditor } = await import("./ProjectOverviewEditor");
    const markup = renderToStaticMarkup(
      <ProjectCardConfigEditor
        title="Alpha"
        websiteUrl={null}
        repositoryUrl={null}
        jourFixe={null}
        onSave={async () => true}
        onCancel={() => undefined}
      />,
    );
    expect(markup).not.toContain("Speichert");
    expect(markup).not.toContain("Gespeichert");
    expect(CARD_UNDO_MS).toBe(5_000);
  });
});
