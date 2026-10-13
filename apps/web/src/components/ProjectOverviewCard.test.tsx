import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type ProjectOverview } from "@workjet/contracts";
import { ProjectOverviewCard } from "./ProjectOverviewCard";
import type { GalleryProject } from "../projectOverview";
import { PROJECT_OVERVIEW_TEXT, projectOverviewFormat } from "../projectOverviewText";

// Diese Tests prüfen deutsche Texte: Oberflächensprache fest auf "de",
// damit "System" nicht von der Testumgebung (englisch) abhängt.
vi.mock("../hooks/useProjectOverviewLanguage", () => ({
  useProjectOverviewLanguage: () => "de",
}));

const project: GalleryProject = {
  key: "instance:greppy",
  id: "greppy",
  title: "greppy.xyz",
  local: null,
  native: true,
};
describe("project card text", () => {
  it("has German and English labels for opening the project and its website", () => {
    for (const language of ["de", "en"] as const) {
      const text = PROJECT_OVERVIEW_TEXT[language];
      expect(projectOverviewFormat(text.cardOpenWebsiteLabel, { title: "a", url: "b" })).toMatch(
        /a.*b/,
      );
      expect(projectOverviewFormat(text.cardOpenProjectLabel, { title: "a" })).toContain("a");
    }
    expect(PROJECT_OVERVIEW_TEXT.en.cardOpenWebsite).toBe("Open website");
    expect(PROJECT_OVERVIEW_TEXT.en.cardOpenProjectLabel).toBe("Open {title}");
  });
});
describe("compact project gallery", () => {
  it.each(["fzul.app", "i-hate-ai.community"])("uses the saved static preview for %s", (title) => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={{ ...project, title }} onOpen={() => {}} />,
    );
    expect(markup).toContain(`alt="Gespeicherte Vorschau von ${title}"`);
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<iframe");
    expect(markup).toContain("2026-10-07");
    expect(markup.match(/data-workjet-project-card-slot="/g)).toHaveLength(3);
  });
  it("opens the project from the title and preview, and the website only via its own link", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={project} onOpen={() => {}} />,
    );
    expect(markup).toMatch(/<h2[^>]*><button[^>]*type="button"[^>]*>greppy.xyz<\/button><\/h2>/);
    expect(markup).not.toMatch(/<h2[^>]*><a/);
    expect(markup).toContain('data-workjet-action="project.open.gallery-title:instance:greppy"');
    expect(markup).toContain('data-workjet-action="project.open.gallery-preview:instance:greppy"');
    expect(markup.match(/href="https:\/\/greppy.xyz"/g)).toHaveLength(1);
    expect(markup).toMatch(
      /<a[^>]*href="https:\/\/greppy.xyz"[^>]*aria-label="Webseite von greppy.xyz öffnen \(https:\/\/greppy.xyz\)"|<a[^>]*aria-label="Webseite von greppy.xyz öffnen \(https:\/\/greppy.xyz\)"[^>]*href="https:\/\/greppy.xyz"/,
    );
    expect(markup).toContain('title="Webseite öffnen"');
    expect(markup).toContain('alt="Gespeicherte Vorschau von greppy.xyz"');
    expect(markup).toContain('aria-label="greppy.xyz öffnen"');
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("Hide preview");
    expect(markup).not.toContain("If the website blocks");
    expect(markup).not.toContain("Nicht eingerichtet");
    expect(markup).toContain("Nutzer");
    expect(markup).toContain("Abfragen");
    expect(markup).toContain("Latenz");
    expect(markup.match(/data-workjet-project-card-slot="/g)).toHaveLength(3);
  });
  it("uses the project logo for a domain without a saved preview", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={{ ...project, title: "example.org" }} onOpen={() => {}} />,
    );
    expect(markup).toContain('href="https://example.org"');
    expect(markup).toContain('aria-label="Logo von example.org"');
    expect(markup).toContain('aria-label="example.org öffnen"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<iframe");
    expect(markup.match(/data-workjet-project-card-slot="/g)).toHaveLength(3);
  });
  it("retains archived values and exposes its actions through the compact menu", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{
          ...project,
          local: {
            id: ProjectId.make("retained"),
            environmentId: EnvironmentId.make("environment"),
            title: project.title,
            updatedAt: "2026-10-06T18:00:00Z",
            ctoxRegistration: null,
            overview: {
              archived: true,
              websiteUrl: "https://fzul.app",
              slots: [{ kind: "text", label: "Status", value: "Retained" }, null, null],
            },
          },
        }}
        onOpen={() => {}}
        onSave={async () => true}
        canArchive
      />,
    );
    expect(markup).toContain('aria-label="Aktionen für greppy.xyz"');
    expect(markup).not.toContain("Configure greppy.xyz KPIs");
    expect(markup).not.toContain("lucide-pencil");
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("Retained");
  });
  it("keeps configuration available through a menu without exposing unsupported archive actions", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={project} onOpen={() => {}} onSave={async () => true} />,
    );
    expect(markup).not.toContain("Configure greppy.xyz KPIs");
    expect(markup).not.toContain("lucide-pencil");
    expect(markup).toContain('aria-label="Aktionen für greppy.xyz"');
    expect(markup).not.toContain("Projekt archivieren");
    expect(markup).not.toContain("Projekt wiederherstellen");
  });
  it("preserves all three configured fields and an explicitly cleared website", () => {
    const overview: ProjectOverview = {
      websiteUrl: null,
      slots: [
        { kind: "text", label: "Status", value: "Ready" },
        { kind: "link", label: "Plan", url: "https://greppy.xyz/plan" },
        { kind: "metric", label: "Queue", value: 7, unit: "tasks" },
      ],
    };
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{
          ...project,
          local: {
            id: ProjectId.make("local"),
            environmentId: EnvironmentId.make("environment"),
            title: project.title,
            updatedAt: "2026-10-06T18:00:00Z",
            ctoxRegistration: null,
            overview,
          },
        }}
        onOpen={() => {}}
      />,
    );
    expect(markup).not.toContain("<iframe");
    expect(markup.match(/data-workjet-project-card-slot="/g)).toHaveLength(3);
    expect(markup).toContain("Ready");
    expect(markup).toContain('href="https://greppy.xyz/plan"');
    expect(markup).toContain("7 tasks");
    expect(markup).toMatch(/<dd class="[^"]*text-\[22px\][^"]*">7 tasks<\/dd>/);
    expect(markup).not.toMatch(/<dt[^>]*class="[^"]*truncate/);
  });
});

describe("inline card back", () => {
  it("shows the dimmed not-rated stamp on cards without an exit value", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={project} onOpen={() => {}} />,
    );
    expect(markup).toContain('data-workjet-exit-model-stamp=""');
    expect(markup).toContain("Nicht bewertet");
    // #561: the stamp itself opens the valuation inline.
    expect(markup).toMatch(/<button[^>]*data-workjet-exit-model-stamp/);
  });
  it("renders the closed card without an expanded marker or a back face", () => {
    for (const props of [
      { onSave: async () => true },
      { onSaveConfiguration: async () => true },
      {},
    ]) {
      const markup = renderToStaticMarkup(
        <ProjectOverviewCard project={project} onOpen={() => {}} {...props} />,
      );
      expect(markup).not.toContain("data-workjet-project-card-expanded");
      expect(markup).not.toContain("data-workjet-project-card-backface");
      expect(markup).toContain('aria-label="Aktionen für greppy.xyz"');
    }
  });
});
