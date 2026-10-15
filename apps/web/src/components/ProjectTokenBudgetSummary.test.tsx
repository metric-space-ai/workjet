import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectTokenBudgetSummary } from "./ProjectTokenBudgetSummary";
const totals = {
  uncachedInputTokens: 1_000_000_000,
  cachedInputTokens: 400_000_000,
  cacheCreationTokens: 0,
  outputTokens: 400_000_000,
  reasoningTokens: 100,
};
const cycle = { start: "2026-10-07T11:00:00Z", end: "2026-10-14T11:00:00Z" };
describe("project budget overview", () => {
  it("always shows a limited or unlimited consumption", () => {
    const view = { totals, cycle, unknown: [], threads: [], limitBillions: 2.3 };
    expect(renderToStaticMarkup(<ProjectTokenBudgetSummary view={view} />)).toContain(
      "1,8/2,3 Mrd. (78 %)",
    );
    expect(
      renderToStaticMarkup(<ProjectTokenBudgetSummary view={{ ...view, limitBillions: null }} />),
    ).toContain("1,8 Mrd.");
  });
  it("shows no value without measured usage and marks partial usage with ≥", () => {
    expect(
      renderToStaticMarkup(
        <ProjectTokenBudgetSummary
          view={{
            totals: null,
            cycle,
            unknown: ["worker · gpu3"],
            threads: [],
            limitBillions: 2.3,
          }}
        />,
      ),
    ).toBe("");
    const markup = renderToStaticMarkup(
      <ProjectTokenBudgetSummary
        view={{ totals, cycle, unknown: ["worker · gpu3"], threads: [], limitBillions: 2.3 }}
      />,
    );
    expect(markup).toContain("≥1,8/2,3 Mrd.");
    expect(markup).not.toContain("worker · gpu3");
    expect(markup).not.toContain("–");
  });
  it("renders nothing when neither usage nor a limit is known", () => {
    expect(
      renderToStaticMarkup(
        <ProjectTokenBudgetSummary
          view={{ totals: null, cycle, unknown: ["worker"], threads: [], limitBillions: null }}
        />,
      ),
    ).toBe("");
  });
  it("highlights 80% without a blocking control", () => {
    const markup = renderToStaticMarkup(
      <ProjectTokenBudgetSummary
        view={{ totals, cycle, unknown: [], threads: [], limitBillions: 2 }}
      />,
    );
    expect(markup).toContain("bg-warning-surface");
    expect(markup).not.toContain("disabled");
  });
});
