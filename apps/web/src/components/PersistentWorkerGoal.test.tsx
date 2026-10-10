import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  ProjectId,
  ThreadId,
  WorkjetThreadGoal,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import { PersistentWorkerGoal, persistentWorkerGoalState } from "./PersistentWorkerGoal";

const goal = Schema.decodeUnknownSync(WorkjetThreadGoal)({
  objective: "Verify the real Molecularity rendering benchmark",
  status: "active",
  revision: 4,
  continuationCount: 2,
  lastCompletedTurnId: "turn-molecularity-2",
  pendingContinuation: null,
  reason: null,
  updatedAt: "2026-10-10T00:00:00Z",
});
const config: WorkjetThreadConfig = {
  ...DEFAULT_WORKJET_THREAD_CONFIG,
  team: {
    role: "specialist",
    domain: "rendering",
    projectId: ProjectId.make("Molecularity"),
    threadId: ThreadId.make("rendering-parent"),
    parentThreadId: ThreadId.make("supervisor"),
    goal: goal.objective,
    createdAt: goal.updatedAt,
  },
  goal,
};

function html(value: WorkjetThreadConfig = config, compact = false) {
  return renderToStaticMarkup(
    <PersistentWorkerGoal config={value} compact={compact} sessionStatus="running" />,
  );
}

describe("persistent worker goal display", () => {
  it("shows the saved objective, revision and loop counter in the thread", () => {
    const text = html();
    expect(text).toContain(goal.objective);
    expect(text).toContain("Running · Continuations 2 · Workjet loop");
    expect(text).toContain("Saved goal · r4");
    expect(text).toContain(`dateTime="${goal.updatedAt}"`);
  });
  it("keeps completed turns separate from any verification claim", () => {
    const text = html();
    expect(text).toContain("Last recorded turn · turn-molecularity-2");
    expect(text).not.toContain("Verified");
    expect(text).not.toContain("native goal");
  });
  it("shows the same objective and status in the project list", () => {
    const text = html(config, true);
    expect(text).toContain('data-workjet-persistent-goal="compact"');
    expect(text).toContain(goal.objective);
    expect(text).toContain("Running · Continuations 2");
  });
  it.each(["supervisor", "worker"] as const)(
    "does not show a goal loop or board on %s threads",
    (role) => {
      if (config.schemaVersion !== 2 || !config.team) throw new Error("Invalid fixture");
      const identity = {
        projectId: config.team.projectId,
        threadId: config.team.threadId,
        goal: config.team.goal,
        createdAt: config.team.createdAt,
      };
      const team =
        role === "supervisor"
          ? { ...identity, role, parentThreadId: null }
          : { ...identity, role, parentThreadId: ThreadId.make("parent"), packageId: "one-pr" };
      expect(html({ ...config, team })).toBe("");
    },
  );
  it("does not turn an imported idle thread into an active loop", () => {
    if (config.schemaVersion !== 2) throw new Error("Invalid fixture");
    const { goal: ignored, ...idle } = config;
    void ignored;
    expect(html(idle)).toBe("");
  });
  it("renders approval and input waits ahead of the live session status", () => {
    expect(
      persistentWorkerGoalState(goal, { sessionStatus: "running", hasPendingApprovals: true }),
    ).toBe("Awaiting approval");
    expect(
      persistentWorkerGoalState(goal, { sessionStatus: "running", hasPendingUserInput: true }),
    ).toBe("Waiting for input");
    expect(
      persistentWorkerGoalState({ ...goal, status: "blocked" }, { sessionStatus: "running" }),
    ).toBe("Blocked");
    expect(
      persistentWorkerGoalState({ ...goal, status: "paused" }, { sessionStatus: "running" }),
    ).toBe("Paused");
  });
  it("retains the durable pending continuation and terminal state", () => {
    const queued = Schema.decodeUnknownSync(WorkjetThreadGoal)({
      ...goal,
      pendingContinuation: {
        commandId: "continue-3",
        messageId: "message-3",
        createdAt: goal.updatedAt,
      },
    });
    expect(persistentWorkerGoalState(queued, {})).toBe("Queued");
    expect(persistentWorkerGoalState({ ...queued, status: "complete" }, {})).toBe("Complete");
  });
  it("uses only the recorded iteration and never renders legacy Kanban cards", () => {
    if (config.schemaVersion !== 2) throw new Error("Invalid fixture");
    const withBoard = {
      ...config,
      goal: {
        ...goal,
        kanban: {
          goalRevision: 4,
          iteration: 3,
          updatedAt: goal.updatedAt,
          cards: [{ id: "private-card", title: "Legacy card content", status: "doing" as const }],
        },
      },
    };
    const text = html(withBoard);
    expect(text).toContain("Iteration 3");
    expect(text).not.toContain("Legacy card content");
    expect(text).not.toContain("Kanban");
  });
});
