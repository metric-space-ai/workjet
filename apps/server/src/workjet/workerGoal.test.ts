import { describe, expect, it } from "vite-plus/test";
import { TurnId, type WorkjetThreadGoal } from "@workjet/contracts";
import { initialWorkerGoal, workerGoalContinuationText } from "./workerGoal.ts";
import { isUnsupportedNativeGoal, workerTurnKanbanFallback } from "./workerToolFallback.ts";

const goal = initialWorkerGoal("Deliver the assigned project outcome.", "2026-10-11T00:00:00.000Z");
describe("worker goal tools and neutral prompts", () => {
  it("emulates only explicitly unsupported native goal protocols", () => {
    expect(isUnsupportedNativeGoal({ cause: { code: -32601 } })).toBe(true);
    expect(
      isUnsupportedNativeGoal({
        message: "Codex native goal controls are unsupported by this runtime.",
      }),
    ).toBe(true);
    expect(isUnsupportedNativeGoal({ message: "Token plan usage limit has been reached" })).toBe(
      false,
    );
    expect(isUnsupportedNativeGoal({ message: "Connection timed out" })).toBe(false);
  });
  it("makes missing tools non-blocking and keeps project names out of continuation instructions", () => {
    const text = workerGoalContinuationText(goal);
    expect(text).not.toMatch(/slide-engine|learnordie|molecularity/i);
    expect(text).toContain("If workjet_worker_kanban is available");
    expect(text).toContain("Workjet records a server-side mini-kanban");
  });
  it.each([
    "claudeAgent",
    "codex",
    "opencode",
    "grok",
    "pi",
    "cursor",
    "minimax",
    "greppy",
    "ctox",
  ])("retains an unverified turn result when %s cannot update the board", (harness) => {
    const kanban = workerTurnKanbanFallback(
      goal,
      TurnId.make("turn"),
      `Reported result from ${harness}.`,
      goal.updatedAt,
    );
    expect(kanban?.cards[0]?.status).toBe("doing");
    expect(kanban?.cards[0]?.title).toBe(`Reported result from ${harness}.`);
    expect(kanban?.cards[0]?.evidence).toContain("unverified");
    expect(kanban?.iteration).toBe(goal.continuationCount);
  });
  it("preserves a worker's saved board and does not invent verified completion", () => {
    const saved: WorkjetThreadGoal = {
      ...goal,
      kanban: {
        goalRevision: goal.revision,
        iteration: goal.continuationCount,
        cards: [],
        updatedAt: goal.updatedAt,
      },
    };
    expect(
      workerTurnKanbanFallback(saved, TurnId.make("turn"), "Report", goal.updatedAt),
    ).toBeUndefined();
  });
});
