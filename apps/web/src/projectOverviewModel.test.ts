import { describe, expect, it } from "vite-plus/test";
import {
  PROJECT_OVERVIEW_LIVE_STALE_MS,
  buildProjectOwnerOverview,
  projectOverviewAttentionRank,
  projectOverviewBudgetValue,
  projectOverviewLastSignOfLife,
  projectOverviewSideSections,
  projectOverviewWorkerState,
  sortByAttention,
  projectOverviewStatusTone,
  projectOverviewWorkerName,
  projectOverviewNextMeetingDate,
} from "./projectOverviewModel";
import { overviewFixture } from "./fixtures/project-overview.fixture-data";

describe("dense owner overview model", () => {
  it("shows the next meeting date in its configured timezone", () => {
    const recurring = { weekday: 3, time: "13:00", timezone: "Europe/Berlin" };
    expect(projectOverviewNextMeetingDate(recurring, Date.parse("2026-10-11T17:00:00Z"))).toBe(
      "2026-10-14",
    );
    expect(projectOverviewNextMeetingDate(recurring, Date.parse("2026-10-14T11:00:00Z"))).toBe(
      "2026-10-21",
    );
    expect(projectOverviewNextMeetingDate(null, Date.now())).toBeNull();
  });
  it("uses dashes for missing values and omits the missing summary", () => {
    const input = overviewFixture("empty");
    const data = buildProjectOwnerOverview(input);
    expect(data.kpis.map((kpi) => kpi.value)).toEqual(["—", "—", "—", "—", "—"]);
    expect(data.summary).toBeNull();
    expect(Object.values(data.text)).not.toContain("—");
  });
  it.each(["de", "en"] as const)("groups setup once alongside progress in %s", (language) => {
    const data = buildProjectOwnerOverview({ ...overviewFixture("full"), language });
    expect(data.history.filter((event) => event.id === "setup")).toHaveLength(1);
    expect(data.history.some((event) => event.id.endsWith(":turn"))).toBe(true);
    expect(data.history.length).toBeLessThanOrEqual(5);
    expect(data.history.map((event) => event.sentence).join(" ")).not.toMatch(
      /was created as|wurde als|a Persistent Workers/iu,
    );
  });
  it("has five distinct status colors and includes Supervisor escalation colors", () => {
    expect(
      ["disrupted", "asks", "running", "waiting", "completed"].map((state) =>
        projectOverviewStatusTone(state as Parameters<typeof projectOverviewStatusTone>[0]),
      ),
    ).toEqual(["red", "blue", "amber", "gray", "green"]);
    expect(projectOverviewStatusTone("waitingSupervisor")).toBe("blue");
    expect(projectOverviewStatusTone("supervisorTimedOut")).toBe("red");
  });
  it("shows blocked goals and escalations independently of owner decisions", () => {
    const data = buildProjectOwnerOverview(overviewFixture("molecularity"));
    expect(data.disruptions).toHaveLength(1);
    expect(data.decisions).toEqual([]);
    const full = buildProjectOwnerOverview(overviewFixture("full"));
    expect(full.escalations).toHaveLength(1);
    expect(full.decisions).toHaveLength(1);
  });
  it("removes the project prefix and separates the harness", () => {
    expect(
      projectOverviewWorkerName("Molecularity · Rechenweg & Referenzlöser (Codex)", "Molecularity"),
    ).toEqual({ name: "Rechenweg & Referenzlöser", harness: "Codex" });
    expect(
      projectOverviewWorkerName("Molecularity Pinball World Engine", "Molecularity").name,
    ).toBe("Pinball World Engine");
  });
  it("formats token usage with and without a limit", () => {
    expect(projectOverviewBudgetValue({ consumedTokens: 1_800_000_000, limitBillions: 2.3 })).toBe(
      "1,8/2,3 Mrd. (78 %)",
    );
    expect(projectOverviewBudgetValue({ consumedTokens: 1_800_000_000, limitBillions: null })).toBe(
      "1,8 Mrd.",
    );
    expect(projectOverviewBudgetValue({ consumedTokens: 0, limitBillions: null })).toBe("0 Tokens");
    expect(projectOverviewBudgetValue({ consumedTokens: 120_000, limitBillions: null })).toBe(
      "120.000 Tokens",
    );
    expect(projectOverviewBudgetValue({ consumedTokens: null, limitBillions: 2.3 })).toBe("—");
    expect(projectOverviewBudgetValue()).toBe("—");
    expect(
      projectOverviewBudgetValue({
        consumedTokens: 1_800_000_000,
        limitBillions: 2.3,
        partial: true,
      }),
    ).toBe("1,8/2,3 Mrd. (≥78 %)");
  });
});

describe("project overview live state (WP-BLICK)", () => {
  const now = Date.parse("2026-10-15T17:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const base = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    waitingOnSupervisor: false,
    workerDecisionProblem: undefined,
    workjetConfig: { schemaVersion: 1 },
  } as const;
  const thread = (
    status: "running" | "starting" | "stopped",
    lastSign: number,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      ...base,
      updatedAt: ago(lastSign),
      session: { status, updatedAt: ago(lastSign), activeTurnId: null },
      latestTurn: { requestedAt: ago(lastSign), startedAt: ago(lastSign), completedAt: null },
      ...extra,
    }) as unknown as Parameters<typeof projectOverviewWorkerState>[0];

  it("reports running only with fresh activity", () => {
    expect(projectOverviewWorkerState(thread("running", 30_000), now)).toBe("running");
    expect(projectOverviewWorkerState(thread("starting", 30_000), now)).toBe("running");
    expect(projectOverviewWorkerState(thread("running", PROJECT_OVERVIEW_LIVE_STALE_MS), now)).toBe(
      "running",
    );
  });
  it("reports a stale running or starting session as stuck", () => {
    expect(
      projectOverviewWorkerState(thread("running", PROJECT_OVERVIEW_LIVE_STALE_MS + 1), now),
    ).toBe("stuck");
    // Measured 15.10.2026: supervisors held "starting" since 14.10. without a process.
    expect(projectOverviewWorkerState(thread("starting", 30 * 3_600_000), now)).toBe("stuck");
    expect(projectOverviewStatusTone("stuck")).toBe("red");
  });
  it("counts a fresh tool activity on the thread as a sign of life", () => {
    const old = thread("running", 600_000, { updatedAt: ago(20_000) });
    expect(projectOverviewWorkerState(old, now)).toBe("running");
  });
  it("does not count a skipped control round as a sign of life", () => {
    const tickAt = ago(10_000);
    const stale = thread("starting", 30 * 3_600_000, {
      updatedAt: tickAt,
      workjetConfig: {
        schemaVersion: 2,
        supervisorTick: { lastTickAt: tickAt, lastControlAt: null, outcome: "skipped-busy" },
      },
    });
    expect(projectOverviewLastSignOfLife(stale)).toBe(now - 30 * 3_600_000);
    expect(projectOverviewWorkerState(stale, now)).toBe("stuck");
  });
  it("trusts live background work and leaves idle sessions waiting", () => {
    expect(
      projectOverviewWorkerState(
        thread("stopped", 30 * 3_600_000, { backgroundLiveness: "working" }),
        now,
      ),
    ).toBe("running");
    expect(projectOverviewWorkerState(thread("stopped", 30 * 3_600_000), now)).toBe("waiting");
  });
});

describe("project overview side column order (WP-BLICK)", () => {
  it("puts action first: live, goals, KPIs, meeting, and drops empty sections", () => {
    expect(
      projectOverviewSideSections({ live: true, goals: true, kpis: true, meeting: true }),
    ).toEqual(["live", "goals", "kpis", "meeting"]);
    expect(
      projectOverviewSideSections({ live: false, goals: true, kpis: false, meeting: true }),
    ).toEqual(["goals", "meeting"]);
    expect(
      projectOverviewSideSections({ live: false, goals: false, kpis: false, meeting: false }),
    ).toEqual([]);
  });
  it("lists stuck and disrupted rows first and keeps the order otherwise", () => {
    const rows = [
      { id: "a", state: "running" },
      { id: "b", state: "asks" },
      { id: "c", state: "stuck" },
      { id: "d", state: "running" },
      { id: "e", state: "disrupted" },
    ] as const;
    expect(
      sortByAttention(rows, (row) => projectOverviewAttentionRank(row.state)).map((row) => row.id),
    ).toEqual(["c", "e", "b", "a", "d"]);
  });
  it("lists disrupted goals before completed and waiting ones", () => {
    const goals = [
      { title: "done", status: "completed" },
      { title: "open", status: "waiting" },
      { title: "broken", status: "disrupted" },
    ] as const;
    expect(
      sortByAttention(goals, (goal) => projectOverviewAttentionRank(goal.status)).map(
        (goal) => goal.title,
      ),
    ).toEqual(["broken", "open", "done"]);
  });
});
