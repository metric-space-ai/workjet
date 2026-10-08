// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  RemoteWorkerDispatchError,
  RemoteWorkerResult,
  type NativeSupervisorWorkerIntent,
  type OrchestrationThread,
  type NativeSupervisorWorkerCompletion,
  type RemoteWorkerResponse,
  type ThreadId,
} from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { CtoxThreadBindingSource } from "./ctox/CtoxThreadBinding.ts";
import { makeCtoxMcpTransport } from "./ctox/CtoxMcpTransport.ts";
import { makeCtoxNativeSupervisorWorkers } from "./ctox/CtoxNativeSupervisorWorkers.ts";
import { DecisionHubConnectionRegistry } from "./decisionHub/DecisionHubConnectionRegistry.ts";
import {
  makeNativeSupervisorWorkerDispatch,
  type NativeSupervisorWorkerSource,
} from "./NativeSupervisorWorkerDispatch.ts";
import { RemoteWorkerBroker } from "./RemoteWorkerBroker.ts";
import { WorkerDispatch, type WorkerDispatchError } from "./WorkerDispatch.ts";

const failure = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });
const encodeResult = Schema.encodeEffect(RemoteWorkerResult);
const decodeResult = Schema.decodeUnknownEffect(RemoteWorkerResult);

export const reconcileNativeWorkerFailure = Effect.fn(
  "NativeSupervisorWorkerDispatch.reconcileFailure",
)(function* (
  read: (
    id: ThreadId,
  ) => Effect.Effect<
    Option.Option<{ readonly response: RemoteWorkerResponse | null }>,
    RemoteWorkerDispatchError
  >,
  intentId: ThreadId,
  error: Pick<WorkerDispatchError, "reason">,
) {
  if (error.reason === "remote-dispatch-pending")
    return Option.none<NativeSupervisorWorkerCompletion>();
  const saved = yield* read(intentId);
  if (Option.isSome(saved)) {
    if (saved.value.response === null) return Option.none<NativeSupervisorWorkerCompletion>();
    if (saved.value.response.outcome.status === "dispatched")
      return Option.some<NativeSupervisorWorkerCompletion>(saved.value.response.outcome.result);
  }
  return Option.some<NativeSupervisorWorkerCompletion>({
    schemaVersion: 1,
    status: "failed",
    reason: error.reason,
  });
});

/** The native daemon owns the command queue and its execution lease. This
 * server-lifetime consumer derives source authority from the current projection,
 * then uses the same dispatcher and durable broker as the normal MCP entrypoint. */
export const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment;
  const query = yield* ProjectionSnapshotQuery;
  const bindings = yield* CtoxThreadBindingSource;
  const connections = yield* DecisionHubConnectionRegistry;
  const workers = yield* WorkerDispatch;
  const broker = yield* RemoteWorkerBroker;
  const native = makeCtoxNativeSupervisorWorkers({
    connections,
    transport: makeCtoxMcpTransport(yield* HttpClient.HttpClient),
  });

  const sourceFor = Effect.fn("NativeSupervisorWorkerDispatch.sourceFor")(function* (
    parent: OrchestrationThread,
  ) {
    if (
      parent.deletedAt !== null ||
      parent.archivedAt !== null ||
      parent.workjetConfig.role !== "orchestrator" ||
      (parent.workjetConfig.schemaVersion === 2 && parent.workjetConfig.team?.role !== "supervisor")
    )
      return yield* failure();
    const facts = yield* bindings.fromStartConfig(parent.workjetConfig);
    if (!facts.binding) return yield* failure();
    return {
      source: {
        sourceEnvironmentId: facts.environmentId,
        sourceSupervisorThreadId: parent.id,
        projectId: parent.projectId,
      },
      scope: facts.binding,
    } satisfies NativeSupervisorWorkerSource;
  });
  const resolve = Effect.fn("NativeSupervisorWorkerDispatch.resolve")(function* (
    intent: NativeSupervisorWorkerIntent,
  ) {
    if ((yield* environment.getEnvironmentId) !== intent.sourceEnvironmentId)
      return yield* failure();
    const model = yield* query.getCommandReadModel().pipe(Effect.mapError(failure));
    const parent = model.threads.find((thread) => thread.id === intent.sourceSupervisorThreadId);
    if (!parent || parent.projectId !== intent.projectId) return yield* failure();
    const source = yield* sourceFor(parent);
    return { parent, source };
  });

  return makeNativeSupervisorWorkerDispatch({
    sources: Effect.gen(function* () {
      const model = yield* query.getCommandReadModel().pipe(Effect.mapError(failure));
      const sources: NativeSupervisorWorkerSource[] = [];
      for (const parent of model.threads) {
        const source = yield* sourceFor(parent).pipe(Effect.option);
        if (Option.isSome(source)) sources.push(source.value);
      }
      return sources;
    }),
    currentSource: (intent) => resolve(intent).pipe(Effect.map(({ source }) => source)),
    register: ({ source, scope }) => native.register(scope, source),
    poll: (scope) =>
      environment.getEnvironmentId.pipe(Effect.flatMap((id) => native.poll(scope, id))),
    dispatch: (registered, intent) =>
      Effect.gen(function* () {
        // Re-read again immediately before the existing dispatch entrypoint. A
        // source swap after polling must never borrow the old registration.
        const { parent, source } = yield* resolve(intent);
        if (
          source.scope.connectionId !== registered.scope.connectionId ||
          source.scope.instanceId !== registered.scope.instanceId ||
          !workers.dispatchNativeIntent
        )
          return yield* failure();
        const invocation: McpInvocationScope = {
          environmentId: source.source.sourceEnvironmentId,
          threadId: parent.id,
          providerSessionId: intent.intentId,
          providerInstanceId: parent.modelSelection.instanceId,
          capabilities: new Set(),
          activeWorkjetMcpCapabilityIds: new Set(parent.workjetConfig.enabledCapabilityIds),
          workjetRole: "orchestrator",
          ctoxBusinessOsBinding: source.scope,
          issuedAt: yield* Clock.currentTimeMillis,
        };
        return yield* workers
          .dispatchNativeIntent(
            invocation,
            {
              task: intent.task,
              ...(intent.title === undefined ? {} : { title: intent.title }),
              ...(intent.computerId === undefined ? {} : { computerId: intent.computerId }),
              ...(intent.workerProfileId === undefined
                ? {}
                : { workerProfileId: intent.workerProfileId }),
            },
            intent.intentId,
          )
          .pipe(
            Effect.matchEffect({
              onSuccess: (result) => {
                if (result.computerId === undefined) return Effect.fail(failure());
                return encodeResult({ ...result, computerId: result.computerId }).pipe(
                  Effect.flatMap(decodeResult),
                  Effect.map(Option.some),
                  Effect.mapError(failure),
                );
              },
              onFailure: (error) =>
                reconcileNativeWorkerFailure(broker.read, intent.intentId, error),
            }),
          );
      }),
    complete: (scope, registration, intent, result) =>
      native.complete(scope, registration, intent, result),
  });
});
export class NativeSupervisorWorkerDispatch extends Context.Service<
  NativeSupervisorWorkerDispatch,
  Effect.Success<typeof make>
>()("workjet/workjet/NativeSupervisorWorkerDispatchLive/NativeSupervisorWorkerDispatch") {}
export const layer = Layer.effect(
  NativeSupervisorWorkerDispatch,
  Effect.gen(function* () {
    const service = yield* make;
    yield* forkParked(
      service.runCycle.pipe(
        Effect.timeout("6 minutes"),
        Effect.catchCause(() => Effect.void),
        Effect.repeat(Schedule.spaced("5 seconds")),
      ),
    );
    return service;
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
