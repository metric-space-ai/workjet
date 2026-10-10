import {
  CommandId,
  rotateWorkjetCtoxWorkerSource,
  type OrchestrationThread,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

type RotationThread = Pick<OrchestrationThread, "id" | "deletedAt" | "workjetConfig">;

/** Subscribe before reading initial state; shutdown owns the consumer fiber. */
export function startCtoxWorkerSourceRotation(dependencies: {
  readonly connections: Pick<DecisionHubConnectionRegistry["Service"], "list" | "subscribeChanges">;
  readonly threads: Effect.Effect<readonly RotationThread[], ProjectionRepositoryError>;
  readonly dispatch: OrchestrationEngineService["Service"]["dispatch"];
}): Effect.Effect<void, never, Scope.Scope | Crypto.Crypto> {
  const reconcile = Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const summaries = yield* dependencies.connections.list;
    const threads = yield* dependencies.threads;
    for (const thread of threads) {
      if (thread.deletedAt !== null) continue;
      const result = rotateWorkjetCtoxWorkerSource(thread.workjetConfig, summaries);
      if (result.error) {
        yield* Effect.logWarning("CTOX worker-source rotation requires a connection choice", {
          threadId: thread.id,
          reason: result.error,
        });
        continue;
      }
      if (!result.changed) continue;
      yield* dependencies
        .dispatch(
          {
            type: "thread.workjet-config.set",
            commandId: CommandId.make(`server:ctox-source-rotation:${yield* crypto.randomUUIDv4}`),
            threadId: thread.id,
            workjetConfig: result.config,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          },
          { expectedWorkjetConfig: thread.workjetConfig },
        )
        .pipe(Effect.catchCause(Effect.logWarning));
    }
  }).pipe(Effect.catchCause(Effect.logWarning));
  return Effect.gen(function* () {
    const changes = yield* dependencies.connections.subscribeChanges;
    yield* reconcile;
    yield* changes.pipe(
      Stream.runForEach(() => reconcile),
      Effect.forkScoped,
    );
  });
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const connections = yield* DecisionHubConnectionRegistry;
    const query = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    yield* startCtoxWorkerSourceRotation({
      connections,
      threads: query.getCommandReadModel().pipe(Effect.map((model) => model.threads)),
      dispatch: engine.dispatch,
    });
  }),
);
