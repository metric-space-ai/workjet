import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, type ProjectOverview } from "@workjet/contracts";
import { ProjectOverviewCard } from "./ProjectOverviewCard";
import type { GalleryProject } from "../projectOverview";

const project: GalleryProject = {
  key: "instance:greppy",
  id: "greppy",
  title: "greppy.xyz",
  local: null,
  native: true,
};
describe("compact project gallery", () => {
  it.each(["fzul.app", "i-hate-ai.community"])("uses the saved static preview for %s", (title) => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={{ ...project, title }} onOpen={() => {}} />,
    );
    expect(markup).toContain(`alt="Saved website preview for ${title}"`);
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<iframe");
    expect(markup).toContain("2026-10-07");
    expect(markup.match(/data-workjet-project-card-slot="/g)).toHaveLength(3);
  });
  it("opens the domain title as a website and shows its saved homepage preview", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={project} onOpen={() => {}} />,
    );
    expect(markup).toContain('href="https://greppy.xyz"');
    expect(markup).toMatch(
      /<h2[^>]*><a[^>]*href="https:\/\/greppy.xyz"[^>]*>greppy.xyz<\/a><\/h2>/,
    );
    expect(markup).toContain('alt="Saved website preview for greppy.xyz"');
    expect(markup).toContain('aria-label="Open greppy.xyz"');
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("Hide preview");
    expect(markup).not.toContain("Open website");
    expect(markup).not.toContain("If the website blocks");
    expect(markup).not.toContain("Not configured");
    expect(markup).toContain("Users");
    expect(markup).toContain("Queries");
    expect(markup).toContain("Latency");
    expect(markup.match(/data-workjet-project-card-slot="/g)).toHaveLength(3);
  });
  it("uses the project logo for a domain without a saved preview", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={{ ...project, title: "example.org" }} onOpen={() => {}} />,
    );
    expect(markup).toContain('href="https://example.org"');
    expect(markup).toContain('aria-label="Project logo for example.org"');
    expect(markup).toContain('aria-label="Open example.org"');
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
    expect(markup).toContain('aria-label="Project actions for greppy.xyz"');
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
    expect(markup).toContain('aria-label="Project actions for greppy.xyz"');
    expect(markup).not.toContain("Archive project");
    expect(markup).not.toContain("Restore project");
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
    expect(markup).toMatch(/<dd class="[^"]*text-lg[^"]*">7 tasks<\/dd>/);
    expect(markup).not.toMatch(/<dt[^>]*class="[^"]*truncate/);
  });
});
