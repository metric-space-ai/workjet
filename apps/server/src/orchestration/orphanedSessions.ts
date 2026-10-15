import {
  CommandId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadId,
} from "@workjet/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

/**
 * A session this process wrote itself may legitimately sit in
 * "starting"/"running" before its provider runtime is registered (the
 * command reactor marks "starting" before the adapter has started). Only
 * after this window does a missing runtime prove the session is orphaned.
 */
export const ORPHANED_SESSION_GRACE_MS = 15 * 60_000;

/** True when the thread's lifecycle state claims a turn is still in flight. */
export function threadSessionLooksBusy(thread: OrchestrationThread): boolean {
  return (
    thread.latestTurn?.state === "running" ||
    thread.session?.activeTurnId != null ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running"
  );
}

/**
 * Whether a busy-looking thread session has no provider runtime behind it.
 *
 * Provider runtimes are child processes of this server: none survives a
 * restart, so a busy session written before this process started can never
 * finish on its own. Native Crew threads are excluded — their pending and
 * started turns are re-driven from the durable Crew admission ledger.
 */
export function isOrphanedThreadSession(
  thread: OrchestrationThread,
  input: {
    readonly liveThreadIds: ReadonlySet<ThreadId>;
    readonly processStartedAtMs: number;
    readonly nowMs: number;
    readonly graceMs?: number;
  },
): boolean {
  if (thread.deletedAt !== null || !threadSessionLooksBusy(thread)) return false;
  if (thread.workjetConfig.schemaVersion === 2 && thread.workjetConfig.ctoxCrewChat) return false;
  if (input.liveThreadIds.has(thread.id)) return false;
  const writtenAt = Date.parse(
    thread.session?.updatedAt ??
      thread.latestTurn?.startedAt ??
      thread.latestTurn?.requestedAt ??
      "",
  );
  if (Number.isNaN(writtenAt)) return true;
  return (
    writtenAt < input.processStartedAtMs ||
    input.nowMs - writtenAt >= (input.graceMs ?? ORPHANED_SESSION_GRACE_MS)
  );
}

/** Thread ids with a provider runtime this process can still drive. */
export const liveProviderThreadIds = (providerService: ProviderServiceShape) =>
  providerService
    .listSessions()
    .pipe(
      Effect.map(
        (sessions) =>
          new Set<ThreadId>(
            sessions
              .filter((session) => session.status !== "closed")
              .map((session) => session.threadId),
          ),
      ),
    );

/**
 * Settle an orphaned session exactly like a provider process exit
 * (`session.exited` → "stopped", no active turn). The projections settle the
 * still-running turn as "interrupted" with its end time. The command id is
 * keyed by the orphaned session write, so the startup sweep and a control
 * round that race on the same session commit it once.
 */
export const settleOrphanedThreadSession = (
  engine: OrchestrationEngineShape,
  thread: OrchestrationThread,
  reason: "startup" | "control-round",
) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const orphanKey =
      thread.session?.updatedAt ?? thread.latestTurn?.startedAt ?? thread.latestTurn?.requestedAt;
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`server:orphaned-session:${thread.id}:${orphanKey ?? "unknown"}`),
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
    yield* Effect.logInfo("orchestration.orphaned-session.settled", {
      threadId: thread.id,
      reason,
      previousStatus: thread.session?.status ?? null,
      previousActiveTurnId: thread.session?.activeTurnId ?? null,
      previousUpdatedAt: thread.session?.updatedAt ?? null,
    });
  });

/**
 * Startup recovery: settle every session a previous server process left in
 * "starting"/"running". Runs before the provider reactors consume commands,
 * so it cannot race a turn start of this process.
 */
export const recoverOrphanedThreadSessions = (input: {
  readonly engine: OrchestrationEngineShape;
  readonly readModel: OrchestrationReadModel;
  readonly providerService: ProviderServiceShape;
  readonly processStartedAtMs: number;
}) =>
  Effect.gen(function* () {
    const liveThreadIds = yield* liveProviderThreadIds(input.providerService);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    let settled = 0;
    for (const thread of input.readModel.threads) {
      if (
        !isOrphanedThreadSession(thread, {
          liveThreadIds,
          processStartedAtMs: input.processStartedAtMs,
          nowMs,
        })
      )
        continue;
      const ok = yield* settleOrphanedThreadSession(input.engine, thread, "startup").pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("orchestration.orphaned-session.settle-failed", {
            threadId: thread.id,
            error,
          }).pipe(Effect.as(false)),
        ),
      );
      if (ok) settled++;
    }
    if (settled > 0)
      yield* Effect.logInfo("orchestration.orphaned-session.startup-recovery", { settled });
    return settled;
  });
