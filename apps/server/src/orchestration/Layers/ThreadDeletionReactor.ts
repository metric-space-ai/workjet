import type { OrchestrationEvent, ThreadId } from "@workjet/contracts";
import { makeDrainableWorker } from "@workjet/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { WorkerWorktreeCleanup } from "../../workjet/WorkerWorktreeCleanup.ts";
import { WorkerCleanupReceiptStore } from "../../workjet/WorkerCleanupReceiptStore.ts";
import { WORKER_REF_PREFIX } from "../../workjet/WorkerDispatch.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
const RETAINED_WORKTREE_PAGE_SIZE = 64;
const RETAINED_WORKTREE_RETRY_INTERVAL = Duration.minutes(15);

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const workerWorktreeCleanup = yield* WorkerWorktreeCleanup;
  const cleanupReceipts = yield* WorkerCleanupReceiptStore;
  const query = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const git = yield* GitVcsDriver;
  const cleanupMutex = yield* Semaphore.make(1);
  const reconcileMutex = yield* Semaphore.make(1);
  let retryCursor: ThreadId | null = null;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    providerService.stopSession({ threadId }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning(
          "thread deletion skipped worktree cleanup after provider stop failed",
          {
            threadId,
            cause: Cause.pretty(cause),
          },
        ).pipe(Effect.as(false));
      }),
    );

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  /**
   * Durable end of a dispatched worker's life: `thread.deleted` is the only
   * boundary that survives a restart. The isolated worker checkout and its
   * branch are released only after the provider verifies a matching merged PR.
   * Unverified source stays on disk and is logged for later recovery.
   */
  const removeWorkerWorktree = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: workerWorktreeCleanup.cleanupDeletedThread(threadId).pipe(
        Effect.tap((outcome) =>
          outcome.status === "cleaned"
            ? Effect.logDebug("thread deletion cleanup removed worker worktree", {
                threadId,
                worktreePath: outcome.worktreePath,
                deletedRefName: outcome.deletedRefName,
              })
            : outcome.reason === "merge-unverified"
              ? Effect.logWarning("thread deletion retained unverified worker source", { threadId })
              : Effect.void,
        ),
        Effect.asVoid,
      ),
      message: "thread deletion cleanup skipped worker worktree removal",
      threadId,
    });

  const processThreadDeleted = (event: ThreadDeletedEvent) =>
    cleanupMutex.withPermit(
      Effect.gen(function* () {
        const { threadId } = event.payload;
        const providerStopped = yield* stopProviderSession(threadId);
        yield* closeThreadTerminals(threadId);
        if (providerStopped) yield* removeWorkerWorktree(threadId);
      }),
    );

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const reconcileRetainedWorkerWorktrees: ThreadDeletionReactorShape["reconcileRetainedWorkerWorktrees"] =
    reconcileMutex.withPermit(
      Effect.gen(function* () {
        const threadIds: ReadonlyArray<ThreadId> =
          yield* query.listDeletedWorkerWorktreeCleanupThreadIds({
            afterThreadId: retryCursor,
            limit: RETAINED_WORKTREE_PAGE_SIZE,
          });
        for (const threadId of threadIds) {
          yield* cleanupMutex.withPermit(
            Effect.gen(function* () {
              const context = yield* query.getThreadWorktreeCleanupContext(threadId).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("retained worker cleanup context unavailable", {
                    threadId,
                    cause,
                  }).pipe(Effect.as(Option.none())),
                ),
              );
              const worktree = Option.getOrUndefined(context);
              if (worktree?.workjetRole !== "worker") return;
              if (worktree.branch !== `${WORKER_REF_PREFIX}${threadId}`) return;
              const worktreePath = worktree.worktreePath;
              if (!worktreePath) return;
              // The projection keeps deleted rows. A verified receipt also
              // needs a retry if deletion succeeded but the final SQL write
              // was interrupted before it could mark completion.
              const local = yield* gitWorkflow
                .localStatus({ cwd: worktreePath })
                .pipe(Effect.orElseSucceed(() => null));
              if (!local?.isRepo) {
                const branch = yield* git
                  .resolveCommit({
                    cwd: worktree.workspaceRoot,
                    revision: `refs/heads/${worktree.branch}`,
                  })
                  .pipe(Effect.orElseSucceed(() => null));
                if (!branch) {
                  const receipt = yield* cleanupReceipts.get(threadId);
                  if (Option.isNone(receipt) || receipt.value.status === "complete") return;
                }
              }
              const providerStopped = yield* stopProviderSession(threadId);
              if (providerStopped) yield* removeWorkerWorktree(threadId);
            }),
          );
        }
        const lastThreadId: ThreadId | undefined = threadIds[threadIds.length - 1];
        retryCursor =
          threadIds.length === RETAINED_WORKTREE_PAGE_SIZE && lastThreadId !== retryCursor
            ? (lastThreadId ?? null)
            : null;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("retained worker worktree reconciliation failed", {
                cause: Cause.pretty(cause),
              }),
        ),
      ),
    );

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
    yield* forkParked(
      reconcileRetainedWorkerWorktrees.pipe(
        Effect.repeat(Schedule.spaced(RETAINED_WORKTREE_RETRY_INTERVAL)),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
    reconcileRetainedWorkerWorktrees,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
