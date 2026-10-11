import { describe, expect, it } from "vite-plus/test";
import {
  buildProjectOwnerOverview,
  projectOverviewBudgetValue,
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
    expect([
      data.text.noGoals,
      data.text.noResults,
      data.text.noHistory,
      data.text.noLastMeeting,
      data.text.noOwnerDecisions,
    ]).toEqual(["—", "—", "—", "—", "—"]);
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
      "1.8/2.3B (78 %)",
    );
    expect(projectOverviewBudgetValue({ consumedTokens: 1_800_000_000, limitBillions: null })).toBe(
      "1.8B",
    );
    expect(projectOverviewBudgetValue({ consumedTokens: 0, limitBillions: null })).toBe("0.0B");
    expect(projectOverviewBudgetValue({ consumedTokens: null, limitBillions: 2.3 })).toBe("—");
    expect(projectOverviewBudgetValue()).toBe("—");
    expect(
      projectOverviewBudgetValue({
        consumedTokens: 1_800_000_000,
        limitBillions: 2.3,
        partial: true,
      }),
    ).toBe("1.8/2.3B (≥78 %)");
  });
});
