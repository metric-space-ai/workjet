import { renderToStaticMarkup } from "react-dom/server";
import * as Schema from "effect/Schema";
import { WorkjetExitModelAssessment } from "@workjet/contracts";
import ctoxAssessment from "../../../../packages/contracts/src/fixtures/ctox-exit-model-assessment.json" with { type: "json" };
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { visitElements } from "../test/reactElementTree";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
import { ProjectExitModelReport, ProjectExitModelSummary } from "./ProjectExitModel";
import { ProjectOverviewCard } from "./ProjectOverviewCard";
import { exitModelFixture } from "../test/exitModelFixture";
import { formatExitEur, formatExitPercent } from "../projectExitModel";

const projectId = "project-one";
const decodeAssessment = Schema.decodeUnknownSync(WorkjetExitModelAssessment);

describe("project exit assessment display", () => {
  it("renders the actual synthetic CTOX producer receipt without translating its financial fields", () => {
    const assessment = decodeAssessment(ctoxAssessment);
    const markup = renderToStaticMarkup(
      <ProjectExitModelReport projectId="project" assessment={assessment} />,
    );
    expect(markup).toContain(formatExitEur(8_050));
    expect(markup).toContain("Vorläufig");
    expect(markup).toContain(formatExitPercent(1));
    expect(markup).toContain("Bewertungsverlauf · 2");
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
            exitModel: exitModelFixture,
          },
        }}
        ctoxInstanceId="managed:test"
        onOpen={() => {}}
      />,
    );
    expect(markup.match(/data-workjet-project-card-slot="/g)).toHaveLength(3);
    expect(markup).toContain(formatExitEur(800_000));
    expect(markup).not.toContain("project.exit_model.menu");
    const stamp = markup.match(
      /<span[^>]*data-workjet-exit-model-stamp=""[^>]*>([\s\S]*?)<\/span>/,
    );
    expect(stamp?.[1]).toBe(formatExitEur(800_000));
  });

  it("distinguishes proceeds, sale probability, conditional price and financing", () => {
    const markup = renderToStaticMarkup(
      <ProjectExitModelReport
        projectId={projectId}
        assessment={exitModelFixture}
        onRefresh={async () => true}
      />,
    );
    expect(markup).toContain("Verkaufschance");
    expect(markup).toContain(formatExitPercent(0.8));
    expect(markup).toContain("Preis bei Verkauf");
    expect(markup).toContain("Kein Erlös");
    expect(markup).toContain("Unternehmenswert");
    expect(markup).toContain(formatExitEur(950_000));
    expect(markup).toContain("Finanzierung");
    expect(markup).toContain("Plan-Budget · 60 Monate");
    expect(markup).toContain("Monatsbudget (Vorschlag)");
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
    expect(markup).toContain("Bewertungsverlauf · 1");
    expect(markup).toContain(formatExitEur(800_000));
  });

  it("shows a muted 'not rated' stamp for a different project's assessment", () => {
    const markup = renderToStaticMarkup(
      <ProjectExitModelSummary projectId="foreign" assessment={exitModelFixture} />,
    );
    expect(markup).not.toContain(formatExitEur(800_000));
    expect(markup).toContain('data-workjet-exit-model-stamp="empty"');
    expect(markup).toMatch(/Nicht bewertet|Not rated/);
  });

  it("stamps the valued exit diagonally with a double border", () => {
    const markup = renderToStaticMarkup(
      <ProjectExitModelSummary
        projectId={exitModelFixture.project_id}
        assessment={exitModelFixture}
      />,
    );
    if (exitModelFixture.result) {
      expect(markup).toContain('data-workjet-exit-model-stamp=""');
      expect(markup).toContain("border-double");
      expect(markup).toContain("-rotate-12");
    }
  });

  it("formats EUR per locale", () => {
    expect(formatExitEur(3_200_000, "de")).toBe("3,2\u00a0Mio.\u00a0€");
    expect(formatExitEur(3_200_000, "en")).toBe("€3.2M");
  });
});

type ExitProps = Parameters<typeof ProjectExitModelReport>[0];
type AnyElement = { props: Record<string, unknown> };

function renderExitTree(props: ExitProps) {
  hooks.beginRender();
  return ProjectExitModelReport(props) as unknown as AnyElement;
}

function findInput(tree: AnyElement, name: string) {
  const found = visitElements(
    tree,
    (element) => element.props["data-workjet-exit-model-input"] === name,
  );
  expect(found, "Eingabefeld " + name).not.toBeNull();
  return found!.props;
}

function findButton(tree: AnyElement, action: string) {
  const found = visitElements(tree, (element) => element.props["data-workjet-action"] === action);
  expect(found, "Knopf " + action).not.toBeNull();
  return found!.props;
}

const changeEvent = (value: string) => ({ currentTarget: { value } });

describe("resource input for the five-year exit assessment", () => {
  beforeEach(() => {
    hooks.reset();
  });

  it("prefills hours, budget and comparison mode from the owner proposal", () => {
    const tree = renderExitTree({
      projectId,
      assessment: exitModelFixture,
      onRefresh: async () => true,
    });
    expect(findInput(tree, "hours").value).toBe("20");
    expect(findInput(tree, "budget").value).toBe("1000");
    expect(findButton(tree, "project.exit_model.mode.specific:" + projectId)["aria-pressed"]).toBe(
      true,
    );
    expect(findButton(tree, "project.exit_model.mode.equal:" + projectId)["aria-pressed"]).toBe(
      false,
    );
  });

  it("sends exactly the three entered values on refresh", async () => {
    const calls: unknown[] = [];
    const onRefresh = async (resources?: unknown) => {
      calls.push(resources);
      return true;
    };
    const props: ExitProps = { projectId, assessment: exitModelFixture, onRefresh };
    // Jede Eingabe löst wie in React einen neuen Rendervorgang aus.
    let tree = renderExitTree(props);
    (findInput(tree, "hours").onChange as (event: unknown) => void)(changeEvent("8"));
    tree = renderExitTree(props);
    (findInput(tree, "budget").onChange as (event: unknown) => void)(changeEvent("250"));
    tree = renderExitTree(props);
    (findButton(tree, "project.exit_model.mode.equal:" + projectId).onClick as () => void)();
    tree = renderExitTree(props);
    (findButton(tree, "project.exit_model.refresh:" + projectId).onClick as () => void)();
    expect(calls).toEqual([
      { hoursPerWeek: 8, monthlyBudgetEur: 250, comparisonMode: "equal_resources" },
    ]);
  });

  it("keeps the refresh button disabled while fields are empty or invalid", () => {
    const assessment = { ...exitModelFixture, resource_proposal: null };
    const props: ExitProps = { projectId, assessment, onRefresh: async () => true };
    let tree = renderExitTree(props);
    expect(findButton(tree, "project.exit_model.refresh:" + projectId).disabled).toBe(true);
    expect(findInput(tree, "hours")["aria-invalid"]).toBeUndefined();
    (findInput(tree, "hours").onChange as (event: unknown) => void)(changeEvent("200"));
    tree = renderExitTree(props);
    (findInput(tree, "budget").onChange as (event: unknown) => void)(changeEvent("-5"));
    tree = renderExitTree(props);
    expect(findInput(tree, "hours")["aria-invalid"]).toBe(true);
    expect(findInput(tree, "budget")["aria-invalid"]).toBe(true);
    expect(findButton(tree, "project.exit_model.refresh:" + projectId).disabled).toBe(true);
    (findInput(tree, "hours").onChange as (event: unknown) => void)(changeEvent("10"));
    tree = renderExitTree(props);
    (findInput(tree, "budget").onChange as (event: unknown) => void)(changeEvent("500"));
    tree = renderExitTree(props);
    (findButton(tree, "project.exit_model.mode.specific:" + projectId).onClick as () => void)();
    tree = renderExitTree(props);
    expect(findButton(tree, "project.exit_model.refresh:" + projectId).disabled).toBe(false);
  });

  it("disables every field and button while research is running", () => {
    const tree = renderExitTree({
      projectId,
      assessment: {
        ...exitModelFixture,
        status: "researching",
        result: null,
        plan_summary: null,
        scenarios: [],
        diagnostics: [],
        sources: [],
      },
      onRefresh: async () => true,
      onCheck: async () => true,
    });
    expect(findInput(tree, "hours").disabled).toBe(true);
    expect(findInput(tree, "budget").disabled).toBe(true);
    expect(findButton(tree, "project.exit_model.mode.equal:" + projectId).disabled).toBe(true);
    expect(findButton(tree, "project.exit_model.mode.specific:" + projectId).disabled).toBe(true);
    expect(findButton(tree, "project.exit_model.refresh:" + projectId).disabled).toBe(true);
  });
});
