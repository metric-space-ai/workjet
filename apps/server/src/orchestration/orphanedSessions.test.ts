import { ThreadId, type OrchestrationThread } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ORPHANED_SESSION_GRACE_MS, isOrphanedThreadSession } from "./orphanedSessions.ts";

const processStartedAtMs = Date.parse("2026-10-15T16:31:00.000Z");
const threadId = ThreadId.make("supervisor");

function thread(input: {
  readonly status: "starting" | "running" | "ready" | "stopped";
  readonly updatedAt: string;
  readonly crew?: boolean;
}): OrchestrationThread {
  return {
    id: threadId,
    deletedAt: null,
    latestTurn: null,
    session: {
      threadId,
      status: input.status,
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: input.updatedAt,
    },
    workjetConfig: input.crew
      ? { schemaVersion: 2, ctoxCrewChat: { crewId: "crew" } }
      : { schemaVersion: 2 },
  } as unknown as OrchestrationThread;
}

describe("isOrphanedThreadSession", () => {
  const noLive = new Set<ThreadId>();

  it("treats a busy session written by a previous process as orphaned", () => {
    const stale = thread({ status: "starting", updatedAt: "2026-10-14T13:43:41.421Z" });
    expect(
      isOrphanedThreadSession(stale, {
        liveThreadIds: noLive,
        processStartedAtMs,
        nowMs: processStartedAtMs + 1_000,
      }),
    ).toBe(true);
  });

  it("keeps a session with a live provider runtime", () => {
    const stale = thread({ status: "running", updatedAt: "2026-10-14T13:43:41.421Z" });
    expect(
      isOrphanedThreadSession(stale, {
        liveThreadIds: new Set([threadId]),
        processStartedAtMs,
        nowMs: processStartedAtMs + 1_000,
      }),
    ).toBe(false);
  });

  it("gives a session this process just marked starting time to register its runtime", () => {
    const fresh = thread({
      status: "starting",
      updatedAt: "2026-10-15T16:32:00.000Z",
    });
    const input = { liveThreadIds: noLive, processStartedAtMs };
    expect(isOrphanedThreadSession(fresh, { ...input, nowMs: processStartedAtMs + 120_000 })).toBe(
      false,
    );
    expect(
      isOrphanedThreadSession(fresh, {
        ...input,
        nowMs: processStartedAtMs + 60_000 + ORPHANED_SESSION_GRACE_MS,
      }),
    ).toBe(true);
  });

  it("ignores settled sessions and native Crew threads", () => {
    const input = { liveThreadIds: noLive, processStartedAtMs, nowMs: processStartedAtMs + 1_000 };
    expect(
      isOrphanedThreadSession(
        thread({ status: "ready", updatedAt: "2026-10-14T13:43:41.421Z" }),
        input,
      ),
    ).toBe(false);
    expect(
      isOrphanedThreadSession(
        thread({ status: "running", updatedAt: "2026-10-14T13:43:41.421Z", crew: true }),
        input,
      ),
    ).toBe(false);
  });
});
