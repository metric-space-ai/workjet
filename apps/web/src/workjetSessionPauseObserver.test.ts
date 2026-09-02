import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planPauseReaction, type WorkjetPauseThread } from "./workjetSessionPauseObserver";

const event = {
  type: "workjet.session.transfer",
  transferId: "transfer-1",
  sessionId: "session-1",
  state: "pause_requested",
  fenceEpoch: 4,
  sourceComputerId: "computer-1",
  targetComputerId: "computer-2",
  deadlineAtMs: 1_788_000_040_000,
  updatedAtMs: 1_788_000_000_000,
} as const;

function thread(input: { running: boolean; sessionId?: string }): WorkjetPauseThread {
  return {
    environmentId: "environment-1" as EnvironmentId,
    id: "thread-1" as ThreadId,
    workjetConfig: {
      schemaVersion: 2,
      role: "standard",
      parent: null,
      managedInstructions: "",
      enabledCapabilityIds: [],
      capabilityBindings: [],
      ctoxSession: {
        instanceId: "managed:welsch",
        sessionId: input.sessionId ?? "session-1",
        fenceEpoch: 4,
      },
    },
    latestTurn: {
      turnId: "turn-1" as never,
      state: input.running ? "running" : "interrupted",
      requestedAt: "2026-09-02T07:00:00.000Z",
      startedAt: "2026-09-02T07:00:01.000Z",
      completedAt: input.running ? null : "2026-09-02T07:00:02.000Z",
      assistantMessageId: null,
    },
    session: input.running
      ? {
          threadId: "thread-1" as ThreadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as never,
          lastError: null,
          updatedAt: "2026-09-02T07:00:01.000Z",
        }
      : null,
  };
}

describe("planPauseReaction", () => {
  it("interrupts the locally sourced thread while its turn is running", () => {
    expect(
      planPauseReaction({
        event,
        threads: [thread({ running: true })],
        localComputerId: "computer-1",
        acknowledged: new Set(),
      }),
    ).toEqual({
      kind: "interrupt",
      threadRef: { environmentId: "environment-1", threadId: "thread-1" },
    });
  });

  it("acknowledges terminal or never-started threads with the last terminal turn", () => {
    expect(
      planPauseReaction({
        event,
        threads: [thread({ running: false })],
        localComputerId: "computer-1",
        acknowledged: new Set(),
      }),
    ).toEqual({
      kind: "ack",
      threadRef: { environmentId: "environment-1", threadId: "thread-1" },
      lastTerminalTurnId: "turn-1",
    });

    const neverStarted = { ...thread({ running: false }), latestTurn: null };
    expect(
      planPauseReaction({
        event,
        threads: [neverStarted],
        localComputerId: "computer-1",
        acknowledged: new Set(),
      }),
    ).toMatchObject({ kind: "ack", lastTerminalTurnId: null });
  });

  it("ignores unrelated states, computers, sessions, and completed transfer ids", () => {
    const base = {
      threads: [thread({ running: false })],
      localComputerId: "computer-1",
      acknowledged: new Set<string>(),
    };
    expect(planPauseReaction({ ...base, event: { ...event, state: "packing" } })).toEqual({
      kind: "ignore",
    });
    expect(
      planPauseReaction({ ...base, event: { ...event, sourceComputerId: "computer-9" } }),
    ).toEqual({ kind: "ignore" });
    expect(
      planPauseReaction({
        ...base,
        threads: [thread({ running: false, sessionId: "other" })],
        event,
      }),
    ).toEqual({ kind: "ignore" });
    expect(planPauseReaction({ ...base, event, acknowledged: new Set(["transfer-1"]) })).toEqual({
      kind: "ignore",
    });
  });
});
