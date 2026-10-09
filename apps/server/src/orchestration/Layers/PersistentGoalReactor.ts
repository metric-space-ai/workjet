import { CommandId, type ThreadId } from "@workjet/contracts";
import { makeDrainableWorker } from "@workjet/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { ProviderNativeGoal } from "../../provider/Services/ProviderAdapter.ts";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import { workerGoalContinuationText } from "../../workjet/workerGoal.ts";

export class PersistentGoalReactor extends Context.Service<
  PersistentGoalReactor,
  {
    readonly start: () => Effect.Effect<void, never, import("effect/Scope").Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("workjet/orchestration/Layers/PersistentGoalReactor") {}

export const makePersistentGoalReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderService;

  const reconcile = Effect.fn("PersistentGoalReactor.reconcile")(function* (threadId: ThreadId) {
    const found = yield* query.getThreadShellById(threadId);
    if (Option.isNone(found)) return;
    const thread = found.value;
    const config = thread.workjetConfig;
    if (
      thread.deletedAt != null ||
      thread.archivedAt !== null ||
      config.schemaVersion !== 2 ||
      config.team?.role !== "specialist" ||
      !config.goal
    )
      return;
    const goal = config.goal;
    if (goal.status !== "active") {
      if (
        providers.nativeGoal &&
        (yield* providers.listSessions()).some((session) => session.threadId === thread.id)
      ) {
        const native = yield* providers.nativeGoal
          .get(thread.id, { allowRecovery: false })
          .pipe(Effect.timeout("10 seconds"));
        if (native !== undefined && native?.status !== goal.status) {
          yield* providers.nativeGoal
            .set(thread.id, goal.objective, goal.status)
            .pipe(Effect.timeout("10 seconds"));
        }
      }
      return;
    }
    if (
      thread.session?.status === "running" ||
      thread.session?.status === "starting" ||
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput
    )
      return;
    const now = DateTime.formatIso(yield* DateTime.now);
    if (
      thread.session?.status === "error" ||
      thread.latestTurn?.state === "error" ||
      thread.latestTurn?.state === "interrupted"
    ) {
      yield* engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.make(`server:goal-error:${thread.id}:${goal.revision}`),
        threadId: thread.id,
        status: "blocked",
        expectedRevision: goal.revision,
        reason:
          thread.session?.lastError ??
          "The provider turn failed or was interrupted. Resolve it before resuming the goal.",
        createdAt: now,
      });
      return;
    }
    if (providers.nativeGoal && thread.session !== null) {
      let nativeResult: Result.Result<ProviderNativeGoal | null | undefined, unknown> | undefined;
      const admitted = yield* engine.runTurnStartIfActive(
        thread.id,
        Effect.gen(function* () {
          nativeResult = yield* providers.nativeGoal!.get(thread.id).pipe(
            Effect.timeout("10 seconds"),
            Effect.flatMap((native) => {
              const ownerRestart =
                goal.pendingContinuation?.commandId.startsWith("server:goal-start:") &&
                (thread.latestTurn === null || thread.latestTurn.turnId === goal.lastCompletedTurnId);
              if (native !== undefined && (native === null || native.objective !== goal.objective || ownerRestart))
                return providers.nativeGoal!.set(thread.id, goal.objective, "active")
                  .pipe(Effect.timeout("10 seconds"), Effect.as(native));
              return Effect.succeed(native);
            }),
            Effect.result,
          );
        }),
        goal.revision,
      );
      if (!admitted || !nativeResult) return;
      if (Result.isFailure(nativeResult)) {
        yield* engine.dispatch({
          type: "thread.goal.set",
          commandId: CommandId.make(`server:goal-native-error:${thread.id}:${goal.revision}`),
          threadId: thread.id,
          status: "blocked",
          expectedRevision: goal.revision,
          reason:
            "Native goal control is unavailable on this harness connection. Inspect the provider error before resuming.",
          createdAt: now,
        });
        return;
      }
      const native = nativeResult.success;
      if (native !== undefined) {
        const ownerRestart =
          goal.pendingContinuation?.commandId.startsWith("server:goal-start:") &&
          (thread.latestTurn === null || thread.latestTurn.turnId === goal.lastCompletedTurnId);
        if (native !== null && native.objective === goal.objective && !ownerRestart && native.status !== "active") {
          yield* engine.dispatch({
            type: "thread.goal.set",
            commandId: CommandId.make(`server:goal-native-state:${thread.id}:${goal.revision}`),
            threadId: thread.id,
            status:
              native.status === "complete"
                ? "complete"
                : native.status === "paused"
                  ? "paused"
                  : "blocked",
            expectedRevision: goal.revision,
            reason: `Codex native goal reports ${native.status} for the retained objective.`,
            createdAt: now,
          });
          return;
        }
      }
    }
    const latest = thread.latestTurn;
    if (
      latest?.state === "completed" &&
      latest.completedAt !== null &&
      latest.turnId !== goal.lastCompletedTurnId
    ) {
      yield* engine.dispatch({
        type: "thread.goal.advance",
        commandId: CommandId.make(
          `server:goal-advance:${thread.id}:${goal.revision}:${latest.turnId}`,
        ),
        threadId: thread.id,
        completedTurnId: latest.turnId,
        expectedRevision: goal.revision,
        createdAt: now,
      });
      return;
    }
    const pending = goal.pendingContinuation;
    if (!pending) return;
    yield* engine.dispatch(
      {
        type: "thread.turn.start",
        commandId: pending.commandId,
        threadId: thread.id,
        goalRevision: goal.revision,
        message: {
          messageId: pending.messageId,
          role: "user",
          text: workerGoalContinuationText(goal),
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: pending.createdAt,
      },
      { deferWhileBusy: true },
    );
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    reconcile(threadId).pipe(
      Effect.catch((error) =>
        Effect.logDebug("persistent goal reconciliation deferred", { threadId, error }),
      ),
    ),
  );
  const reconcileSaved = Effect.fn("PersistentGoalReactor.reconcileSaved")(function* () {
    const snapshot = yield* query.getCommandReadModel();
    for (const thread of snapshot.threads) {
      if (
        thread.workjetConfig.schemaVersion === 2 &&
        thread.workjetConfig.goal?.status === "active"
      ) {
        yield* worker.enqueue(thread.id);
      }
    }
  });
  const start = Effect.fn("PersistentGoalReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (
          event.aggregateKind !== "thread" ||
          ![
            "thread.session-set",
            "thread.workjet-config-set",
            "thread.activity-appended",
            "thread.unarchived",
            "thread.turn-diff-completed",
          ].includes(event.type)
        )
          return Effect.void;
        return worker.enqueue(event.aggregateId as ThreadId);
      }),
    );
    // Recovery reads only the lightweight command snapshot, never transcript bodies.
    yield* forkParked(
      reconcileSaved().pipe(
        Effect.catch((error) => Effect.logWarning("persistent goal recovery failed", { error })),
        Effect.repeat(Schedule.spaced("30 seconds")),
      ),
    );
  });
  return { start, drain: worker.drain };
});

export const PersistentGoalReactorLive = Layer.effect(
  PersistentGoalReactor,
  makePersistentGoalReactor,
);
