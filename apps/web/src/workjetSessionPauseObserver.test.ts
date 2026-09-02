import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  planPauseReaction,
  runPauseHardCancel,
  type WorkjetPauseThread,
} from "./workjetSessionPauseObserver";

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

  it("acknowledges a confirmed stopped session without reporting a running turn", () => {
    const stopped = {
      ...thread({ running: true }),
      session: {
        ...thread({ running: true }).session!,
        status: "stopped" as const,
        activeTurnId: null,
      },
    };

    expect(
      planPauseReaction({
        event,
        threads: [stopped],
        localComputerId: "computer-1",
        acknowledged: new Set(),
      }),
    ).toEqual({
      kind: "ack",
      threadRef: { environmentId: "environment-1", threadId: "thread-1" },
      lastTerminalTurnId: null,
    });
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

describe("runPauseHardCancel", () => {
  const threadRef = {
    environmentId: "environment-1" as EnvironmentId,
    threadId: "thread-1" as ThreadId,
  };

  it("requests session stop, waits for confirmed stopped state, then acknowledges", async () => {
    let observed = thread({ running: true });
    let nowMs = 0;
    let stopRequests = 0;
    const acknowledgements: Array<string | null> = [];
    let warnings = 0;

    const result = await runPauseHardCancel({
      transferId: "transfer-1",
      threadRef,
      requestedTransferIds: new Set(),
      requestStop: () => {
        stopRequests += 1;
      },
      readThread: () => observed,
      acknowledge: (turnId) => {
        acknowledgements.push(turnId);
      },
      onUnconfirmed: () => {
        warnings += 1;
      },
      timeoutMs: 15_000,
      pollMs: 250,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        nowMs += milliseconds;
        observed = {
          ...observed,
          session: {
            ...observed.session!,
            status: "stopped",
            activeTurnId: null,
          },
        };
      },
    });

    expect(result).toBe("confirmed");
    expect(stopRequests).toBe(1);
    expect(acknowledgements).toEqual([null]);
    expect(warnings).toBe(0);
  });

  it("does not acknowledge when provider-session stop stays unconfirmed", async () => {
    let nowMs = 0;
    let stopRequests = 0;
    let acknowledgements = 0;
    let warnings = 0;

    const result = await runPauseHardCancel({
      transferId: "transfer-1",
      threadRef,
      requestedTransferIds: new Set(),
      requestStop: () => {
        stopRequests += 1;
      },
      readThread: () => thread({ running: true }),
      acknowledge: () => {
        acknowledgements += 1;
      },
      onUnconfirmed: () => {
        warnings += 1;
      },
      timeoutMs: 15_000,
      pollMs: 250,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        nowMs += milliseconds;
      },
    });

    expect(result).toBe("unconfirmed");
    expect(stopRequests).toBe(1);
    expect(acknowledgements).toBe(0);
    expect(warnings).toBe(1);
    expect(nowMs).toBe(15_000);
  });

  it("dispatches stop exactly once for repeated handling of one transfer", async () => {
    let stopRequests = 0;
    const requestedTransferIds = new Set<string>();
    const run = () =>
      runPauseHardCancel({
        transferId: "transfer-1",
        threadRef,
        requestedTransferIds,
        requestStop: () => {
          stopRequests += 1;
        },
        readThread: () => thread({ running: true }),
        acknowledge: () => undefined,
        onUnconfirmed: () => undefined,
        timeoutMs: 0,
        pollMs: 250,
      });

    expect(await run()).toBe("unconfirmed");
    expect(await run()).toBe("unconfirmed");
    expect(stopRequests).toBe(1);
  });
});
