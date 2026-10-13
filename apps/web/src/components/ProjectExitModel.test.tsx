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
import {
  ProjectExitModelCardPanel,
  ProjectExitModelReport,
  ProjectExitModelSummary,
} from "./ProjectExitModel";
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
    // #561: ein Tipp auf den Stempel öffnet die Bewertung inline auf der Karte.
    expect(markup).not.toContain('aria-label="Fünf-Jahres-Exit-Bewertung ansehen"');
    const stamp = markup.match(
      /<button[^>]*data-workjet-exit-model-stamp=""[^>]*>([\s\S]*?)<\/button>/,
    );
    expect(stamp?.[1]).toBe(formatExitEur(800_000));
    expect(stamp?.[0]).toContain("cursor-pointer");
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

  it("keeps the stamp visible without a value, dimmed as not rated", () => {
    for (const assessment of [null]) {
      const markup = renderToStaticMarkup(
        <ProjectExitModelSummary projectId={projectId} assessment={assessment} />,
      );
      expect(markup).toContain('data-workjet-exit-model-stamp=""');
      expect(markup).toContain("Nicht bewertet");
      expect(markup).toContain("pointer-events-none");
      // Derselbe feste Grund wie der Wertstempel, nur Text und Rahmen gedämpft.
      expect(markup).toContain("bg-background/90");
      expect(markup).not.toContain("<button");
    }
  });

  it("hides a different project's value on a reused card but keeps the stamp", () => {
    const markup = renderToStaticMarkup(
      <ProjectExitModelSummary projectId="foreign" assessment={exitModelFixture} />,
    );
    expect(markup).not.toContain(formatExitEur(800_000));
    // Ohne gültigen Wert zeigt derselbe Stempel gedämpft „Nicht bewertet“.
    expect(markup).toContain("Nicht bewertet");
    expect(markup).toContain("pointer-events-none");
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

describe("exit card back panel", () => {
  it("renders the dense resources row and a one-line status without instance", () => {
    const markup = renderToStaticMarkup(
      <ProjectExitModelCardPanel projectId={projectId} instanceId={null} assessment={null} />,
    );
    expect(markup).toContain('data-workjet-project-card-exit=""');
    expect(markup).toContain("Std./Woche");
    expect(markup).toContain("€/Monat");
    expect(markup).toContain(">Gleiche Ressourcen<");
    expect(markup).toContain(">Projektbezogen<");
    expect(markup).toContain("Bewerten");
    expect(markup).not.toContain("— · Nicht bewertet");
    expect(markup).toContain("Instanz nicht verbunden");
    expect(markup).not.toContain("Szenarien");
    expect(markup).not.toContain("Quellen");
  });

  it("shows value and state in one status line", () => {
    const markup = renderToStaticMarkup(
      <ProjectExitModelCardPanel
        projectId={projectId}
        instanceId={null}
        assessment={exitModelFixture}
      />,
    );
    expect(markup).toContain(formatExitEur(800_000));
    expect(markup).toContain("Vorläufig");
  });

  it("lists only non-field gaps as text; the resource plan is the fields themselves (#578)", () => {
    const markup = renderToStaticMarkup(
      <ProjectExitModelCardPanel
        projectId={projectId}
        instanceId={null}
        assessment={{
          ...exitModelFixture,
          status: "blocked",
          result: null,
          plan_summary: null,
          scenarios: [],
          diagnostics: [],
          missing_inputs: ["confirmed_resource_plan", "research_inputs"],
        }}
      />,
    );
    expect(markup).toContain("Angaben fehlen");
    expect(markup).not.toContain("Bestätigter Ressourcenplan");
    expect(markup).toContain("fehlt: Recherchierte Betriebs- und Verkaufsannahmen");
  });
});
