import { describe, expect, it } from "vite-plus/test";
import { projectOverviewTokenBudgetSource } from "./useProjectOverviewTokenBudgetSource";
import { overviewFixture } from "../fixtures/project-overview.fixture-data";
import { buildProjectOwnerOverview } from "../projectOverviewModel";
import type { UsageView } from "../state/usage";

const project = { ...overviewFixture("full").project, native: false };
const known: UsageView = {
  merged: {
    uncachedInputTokens: 1_000_000_000,
    cachedInputTokens: 300_000_000,
    cacheCreationTokens: 100_000_000,
    outputTokens: 400_000_000,
    duplicateSources: [],
  },
  environments: [{ summary: { buckets: [{}], projectThreads: [] }, error: null }],
  isPending: false,
} as unknown as UsageView;

describe("overview reads the canonical #417 budget source", () => {
  it("includes all four token categories and the saved limit in the fifth tile", () => {
    const limited = {
      ...project,
      local: {
        ...project.local!,
        overview: {
          ...project.local!.overview!,
          tokenBudget: { limitBillions: 2.3, revision: 1, jourFixe: null },
        },
      },
    };
    const source = projectOverviewTokenBudgetSource(limited, known);
    expect(source).toEqual({ consumedTokens: 1_800_000_000, limitBillions: 2.3, partial: false });
    expect(
      buildProjectOwnerOverview({
        ...overviewFixture("full"),
        project: limited,
        projectTokenBudgetSource: source,
      }).kpis.at(-1)?.value,
    ).toBe("1,8/2,3 Mrd. (78 %)");
  });
  it("keeps consumption without inventing a limit", () => {
    expect(projectOverviewTokenBudgetSource(project, known)).toMatchObject({
      consumedTokens: 1_800_000_000,
      limitBillions: null,
    });
  });
  it("reports zero only when project attribution is complete", () => {
    const empty = {
      ...known,
      merged: {
        ...known.merged,
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
      },
      environments: [{ summary: { buckets: [], projectThreads: [] }, error: null }],
    } as unknown as UsageView;
    expect(projectOverviewTokenBudgetSource(project, empty).consumedTokens).toBe(0);
    expect(
      projectOverviewTokenBudgetSource({ ...project, native: true }, empty).consumedTokens,
    ).toBeNull();
  });
  it("never shows zero for a pending or failed source", () => {
    expect(
      projectOverviewTokenBudgetSource(project, { ...known, isPending: true }).consumedTokens,
    ).toBeNull();
    const failed = {
      ...known,
      environments: [{ summary: null, error: "offline" }],
    } as unknown as UsageView;
    expect(projectOverviewTokenBudgetSource(project, failed)).toMatchObject({
      consumedTokens: null,
      partial: true,
    });
    const source = projectOverviewTokenBudgetSource(project, failed);
    expect(
      buildProjectOwnerOverview({
        ...overviewFixture("full"),
        projectTokenBudgetSource: source,
      }).kpis.at(-1),
    ).toMatchObject({ value: "—", note: null });
  });
  it("preserves lower bounds for native, duplicate and incomplete sources", () => {
    expect(projectOverviewTokenBudgetSource({ ...project, native: true }, known).partial).toBe(
      true,
    );
    expect(
      projectOverviewTokenBudgetSource(project, {
        ...known,
        merged: { ...known.merged, duplicateSources: ["same"] },
      } as unknown as UsageView).partial,
    ).toBe(true);
    const unknown = {
      ...known,
      environments: [{ summary: { buckets: [{}] }, error: null }],
    } as unknown as UsageView;
    expect(projectOverviewTokenBudgetSource(project, unknown)).toMatchObject({
      consumedTokens: 1_800_000_000,
      partial: true,
    });
  });
});
