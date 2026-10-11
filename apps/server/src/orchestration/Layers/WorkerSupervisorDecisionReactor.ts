import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@workjet/shared/DrainableWorker";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { forkParked } from "../../serverActivation.ts";
import { deliverWorkerDecisions } from "../../workjet/WorkerSupervisorDecisions.ts";

export class WorkerSupervisorDecisionReactor extends Context.Service<WorkerSupervisorDecisionReactor, {
  readonly start: () => Effect.Effect<void, never, import("effect/Scope").Scope>;
  readonly drain: Effect.Effect<void>;
}>()("workjet/orchestration/Layers/WorkerSupervisorDecisionReactor") {}

export const WorkerSupervisorDecisionReactorLive = Layer.effect(WorkerSupervisorDecisionReactor,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const worker = yield* makeDrainableWorker((_: void) => deliverWorkerDecisions().pipe(
      Effect.catch(error => Effect.logWarning("worker decision delivery deferred", { error })),
    ));
    const start = Effect.fn("WorkerSupervisorDecisionReactor.start")(function* () {
      yield* forkParked(Stream.runForEach(engine.streamDomainEvents, event =>
        event.aggregateKind === 'thread' && ['thread.activity-appended', 'thread.session-set', 'thread.created', 'thread.unarchived'].includes(event.type)
          ? worker.enqueue(undefined) : Effect.void));
      yield* forkParked(worker.enqueue(undefined).pipe(Effect.repeat(Schedule.spaced('30 seconds'))));
    });
    return { start, drain: worker.drain };
  }),
);
