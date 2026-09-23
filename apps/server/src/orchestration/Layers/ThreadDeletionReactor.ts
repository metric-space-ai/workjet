import type { OrchestrationEvent } from "@workjet/contracts";
import { makeDrainableWorker } from "@workjet/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { WorkerWorktreeCleanup } from "../../workjet/WorkerWorktreeCleanup.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

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

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    const providerStopped = yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    if (providerStopped) {
      yield* removeWorkerWorktree(threadId);
    }
  });

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

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
