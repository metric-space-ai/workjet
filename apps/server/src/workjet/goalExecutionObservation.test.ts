import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MODEL, DEFAULT_WORKJET_THREAD_CONFIG, EventId, ProviderDriverKind,
  ProviderInstanceId, ThreadId, TurnId, type ProviderRuntimeEvent,
} from "@workjet/contracts";
import { goalExecutionObservation } from "./goalExecutionObservation.ts";
import { initialWorkerGoal, withoutGoalObservations } from "./workerGoal.ts";

const base = {
  eventId: EventId.make("provider-start"),
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  threadId: ThreadId.make("parent"),
  turnId: TurnId.make("actual-turn"),
  createdAt: "2026-10-10T03:00:00.000Z",
  providerRefs: {},
};
const start: ProviderRuntimeEvent = { ...base, type: "turn.started", payload: { model: DEFAULT_MODEL } };
const author: ProviderRuntimeEvent = {
  ...base,
  eventId: EventId.make("sdk-author"),
  type: "thread.metadata.updated",
  payload: { metadata: { workjetAuthorModel: DEFAULT_MODEL } },
  raw: { source: "claude.sdk.message", method: "claude/assistant/model", payload: { model: DEFAULT_MODEL } },
};

describe("goal producer observations", () => {
  it("records the actual emitting instance without promoting a requested model to author", () => {
    const actual = goalExecutionObservation(start);
    expect(actual?.providerInstanceId).toBe(base.providerInstanceId);
    expect(actual?.author).toBeNull();
    expect(actual?.runtimeSource).toBeNull();
    expect(actual?.state).toBe("running");
  });
  it("requires an SDK assistant witness and keeps it across the same completed turn", () => {
    const observed = goalExecutionObservation(author, goalExecutionObservation(start));
    expect(observed?.author).toEqual({
      model: DEFAULT_MODEL, evidence: "assistant-response", sourceEventId: author.eventId,
    });
    const completed = goalExecutionObservation({
      ...base, eventId: EventId.make("provider-complete"), type: "turn.completed", payload: { state: "completed" },
    }, observed);
    expect(completed?.author).toEqual(observed?.author);
    expect(completed?.state).toBe("completed");
    const next = goalExecutionObservation({ ...start, turnId: TurnId.make("next-turn") }, completed);
    expect(next?.author).toBeNull();
    expect(next?.state).toBe("running");
    const moved = goalExecutionObservation({
      ...start, providerInstanceId: ProviderInstanceId.make("different-instance"),
    }, completed);
    expect(moved?.author).toBeNull();
  });
  it("does not infer authorship from other metadata, times, missing identity or duplicated snapshots", () => {
    expect(goalExecutionObservation({ ...author, raw: { source: "acp.jsonrpc", payload: {} } })).toBeUndefined();
    expect(goalExecutionObservation({ ...start, providerInstanceId: undefined })).toBeUndefined();
    expect(goalExecutionObservation({ ...author, provider: ProviderDriverKind.make("codex") })).toBeUndefined();
    expect(goalExecutionObservation(author, goalExecutionObservation(author))).toBeUndefined();
    expect(goalExecutionObservation({ ...base, type: "turn.plan.updated", payload: { plan: [] } })).toBeUndefined();
  });
  it("keeps completion unverified and discards client-supplied producer/verification claims", () => {
    const goal = initialWorkerGoal("Deliver the approved outcome.", base.createdAt);
    expect(goal.lastVerifiedProgress).toBeNull();
    const config = withoutGoalObservations({
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      schemaVersion: 2,
      goal: {
        ...goal, lastExecution: goalExecutionObservation(author),
        executor: {
          implementation: "workjet-persistent-goal-reactor.v1", goalControl: "provider-native",
          providerInstanceId: base.providerInstanceId, observedAt: base.createdAt,
        },
        lastVerifiedProgress: {
          verifierId: "untrusted-client", receiptId: "client-claim", turnId: base.turnId,
          sourceRevision: "unverified", verifiedAt: base.createdAt,
        },
      },
    });
    expect(config.schemaVersion).toBe(2);
    if (config.schemaVersion !== 2) throw new Error("old config");
    expect(config.goal?.lastExecution).toBeUndefined();
    expect(config.goal?.executor).toBeUndefined();
    expect(config.goal?.lastVerifiedProgress).toBeNull();
  });
});
