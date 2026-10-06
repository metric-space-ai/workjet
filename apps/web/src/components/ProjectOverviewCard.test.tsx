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

describe("project gallery previews", () => {
  it("previews a domain-named native project immediately in an isolated lazy frame", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={project} onOpen={() => {}} />,
    );
    expect(markup).toContain('src="https://greppy.xyz"');
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain("Hide preview");
    expect(markup.match(/data-workjet-project-card-slot="/g)).toHaveLength(3);
  });

  it("keeps all three saved fields and an explicitly cleared website", () => {
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
  });
});
