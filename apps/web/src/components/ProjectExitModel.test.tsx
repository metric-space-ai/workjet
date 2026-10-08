import { renderToStaticMarkup } from "react-dom/server";
import * as Schema from "effect/Schema";
import { WorkjetExitModelAssessment } from "@workjet/contracts";
import ctoxAssessment from "../../../../packages/contracts/src/fixtures/ctox-exit-model-assessment.json" with { type: "json" };
import { describe, expect, it } from "vite-plus/test";
import { ProjectExitModelReport, ProjectExitModelSummary } from "./ProjectExitModel";
import { ProjectOverviewCard } from "./ProjectOverviewCard";
import { exitModelFixture } from "../test/exitModelFixture";

const projectId = "project-one";

describe("project exit assessment display", () => {
  it("renders the actual synthetic CTOX producer receipt without translating its financial fields", () => {
    const assessment = Schema.decodeUnknownSync(WorkjetExitModelAssessment)(ctoxAssessment);
    const markup = renderToStaticMarkup(
      <ProjectExitModelReport projectId="project" assessment={assessment} />,
    );
    expect(markup).toContain("8.1k EUR");
    expect(markup).toContain("Provisional");
    expect(markup).toContain("100%");
    expect(markup).toContain("Assessment history · 2");
    expect(markup).toContain("Fictitious test values");
    expect(markup).toContain("test fixture only; not a real project");
    expect(markup).not.toContain("since previous calculated assessment");
  });

  it("adds the fixed exit measure without replacing the three project KPI slots", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{
          key: "managed:test:project-one",
          id: projectId,
          title: "Synthetic project",
          local: null,
          native: true,
          configuration: {
            id: exitModelFixture.project_id,
            title: "Synthetic project",
            workingCopies: [],
            exitModel: exitModelFixture,
          },
        }}
        ctoxInstanceId="managed:test"
        onOpen={() => {}}
      />,
    );
    expect(markup.match(/data-workjet-project-card-slot="/g)).toHaveLength(3);
    expect(markup).toContain("800k EUR");
    expect(markup).toContain('aria-label="View five-year exit assessment"');
    const stamp = markup.match(
      /<button[^>]*data-workjet-exit-model-stamp=""[^>]*>([\s\S]*?)<\/button>/,
    );
    expect(stamp?.[1]).toBe("800k EUR");
  });

  it("distinguishes proceeds, sale probability, conditional price and financing", () => {
    const markup = renderToStaticMarkup(
      <ProjectExitModelReport
        projectId={projectId}
        assessment={exitModelFixture}
        onRefresh={async () => true}
      />,
    );
    expect(markup).toContain("Sale probability");
    expect(markup).toContain("80%");
    expect(markup).toContain("Price if sold");
    expect(markup).toContain("Zero proceeds");
    expect(markup).toContain("Enterprise value");
    expect(markup).toContain("950k EUR");
    expect(markup).toContain("Funding");
    expect(markup).toContain("Plan budget · 60 months");
    expect(markup).toContain("Proposed monthly budget");
    expect(markup).toContain("https://example.org/synthetic-evidence");
    expect(markup).toContain("Synthetic test assumptions");
  });

  it("shows missing inputs and retains the old result solely in dated history", () => {
    const markup = renderToStaticMarkup(
      <ProjectExitModelReport
        projectId={projectId}
        assessment={{
          ...exitModelFixture,
          status: "blocked",
          result: null,
          scenarios: [],
          diagnostics: [],
          missing_inputs: ["Confirmed sale perimeter"],
          history: [
            {
              run_id: "old-run",
              as_of: "2026-10-08",
              exit_date: "2031-10-08",
              status: "provisional",
              result: exitModelFixture.result,
              missing_inputs: [],
            },
          ],
        }}
      />,
    );
    expect(markup).toMatch(/data-workjet-exit-model-value="">—<\/p>/);
    expect(markup).toContain("Confirmed sale perimeter");
    expect(markup).toContain("Assessment history · 1");
    expect(markup).toContain("800k EUR");
  });

  it("hides a different project's assessment on a reused card", () => {
    const markup = renderToStaticMarkup(
      <ProjectExitModelSummary
        projectId="foreign"
        assessment={exitModelFixture}
        onOpen={() => {}}
      />,
    );
    expect(markup).not.toContain("800k EUR");
    expect(markup).toContain("Assessment unavailable");
  });
});
