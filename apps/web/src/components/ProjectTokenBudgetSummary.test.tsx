import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectTokenBudgetSummary } from "./ProjectTokenBudgetSummary";
const totals = { uncachedInputTokens: 1_000_000_000, cachedInputTokens: 400_000_000, cacheCreationTokens: 0, outputTokens: 400_000_000, reasoningTokens: 100 };
const cycle = { start: "2026-10-07T11:00:00Z", end: "2026-10-14T11:00:00Z" };
describe("project budget overview", () => {
  it("always shows a limited or unlimited consumption", () => {
    const view = { totals, cycle, unknown: [], threads: [], limitBillions: 2.3 };
    expect(renderToStaticMarkup(<ProjectTokenBudgetSummary view={view} />)).toContain("1.8/2.3B (78 %)");
    expect(renderToStaticMarkup(<ProjectTokenBudgetSummary view={{ ...view, limitBillions: null }} />)).toContain("1.8B");
  });
  it("shows missing usage rather than a false zero", () => {
    const markup = renderToStaticMarkup(<ProjectTokenBudgetSummary view={{ totals: null, cycle, unknown: ["worker · gpu3"], threads: [], limitBillions: 2.3 }} />);
    expect(markup).toContain("unbekannt/2.3B");
    expect(markup).toContain("Usage teilweise unbekannt");
    expect(markup).toContain("worker · gpu3");
  });
  it("highlights 80% without a blocking control", () => {
    const markup = renderToStaticMarkup(<ProjectTokenBudgetSummary view={{ totals, cycle, unknown: [], threads: [], limitBillions: 2 }} />);
    expect(markup).toContain("bg-amber-500/10");
    expect(markup).not.toContain("disabled");
  });
});
