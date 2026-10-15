import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { PersistentGoalReactor } from "./PersistentGoalReactor.ts";
import { WorkerSupervisorDecisionReactor } from "./WorkerSupervisorDecisionReactor.ts";
import { SupervisorTickReactor } from "./SupervisorTickReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { recoverOrphanedThreadSessions } from "../orphanedSessions.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const persistentGoals = yield* PersistentGoalReactor;
  const workerDecisions = yield* WorkerSupervisorDecisionReactor;
  const supervisorTicks = yield* SupervisorTickReactor;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const processStartedAtMs = DateTime.toEpochMillis(yield* DateTime.now);

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    // Provider runtimes die with the previous server process. Settle the
    // sessions they left "starting"/"running" before any reactor consumes
    // commands, otherwise every busy check (supervisor control rounds,
    // deferred turn starts, settle) treats those threads as busy forever.
    yield* query.getCommandReadModel().pipe(
      Effect.flatMap((readModel) =>
        recoverOrphanedThreadSessions({ engine, readModel, providerService, processStartedAtMs }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("orchestration.orphaned-session.startup-recovery-failed", { error }),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("orchestration.orphaned-session.startup-recovery-defect", { defect }),
      ),
    );
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
    yield* agentAwarenessRelay.start();
    yield* persistentGoals.start();
    yield* workerDecisions.start();
    yield* supervisorTicks.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
