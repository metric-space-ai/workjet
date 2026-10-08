import {
  type EnvironmentId,
  NativeSupervisorSourceRegistration,
  NativeSupervisorWorkerIntent,
  NATIVE_SUPERVISOR_WORKER_CONTRACT,
  RemoteWorkerDispatchError,
  type NativeSupervisorSource,
  NativeSupervisorWorkerCompletion,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import type { makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import type { RemoteWorkerNativeScope } from "./CtoxRemoteWorkerAdmission.ts";

const PollReceipt = Schema.Struct({
  contract: Schema.Literal(NATIVE_SUPERVISOR_WORKER_CONTRACT),
  intents: Schema.Array(NativeSupervisorWorkerIntent).check(
    Schema.makeFilter((value) => value.length <= 1 || "poll is bounded to one intent"),
  ),
});
const CompleteReceipt = Schema.Struct({
  contract: Schema.Literal(NATIVE_SUPERVISOR_WORKER_CONTRACT),
  registrationId: Schema.String,
  revision: Schema.Int,
  intentId: Schema.String,
});
const decodeRegistration = Schema.decodeUnknownEffect(NativeSupervisorSourceRegistration);
const decodePoll = Schema.decodeUnknownEffect(PollReceipt);
const decodeComplete = Schema.decodeUnknownEffect(CompleteReceipt);
const failure = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });
const sameSource = (left: NativeSupervisorSource, right: NativeSupervisorSource) =>
  left.sourceEnvironmentId === right.sourceEnvironmentId &&
  left.sourceSupervisorThreadId === right.sourceSupervisorThreadId &&
  left.projectId === right.projectId;

/** Native agent sessions cannot call the managed-source side of this channel.
 * Every operation resolves the current existing owner-authenticated connection. */
export function makeCtoxNativeSupervisorWorkers(dependencies: {
  readonly connections: Pick<DecisionHubConnectionRegistry["Service"], "resolveReadyTarget">;
  readonly transport: ReturnType<typeof makeCtoxMcpTransport>;
}) {
  const invoke = Effect.fn("CtoxNativeSupervisorWorkers.invoke")(function* (
    scope: RemoteWorkerNativeScope,
    args: Record<string, unknown>,
  ) {
    const target = yield* dependencies.connections
      .resolveReadyTarget(scope.connectionId, scope.instanceId)
      .pipe(Effect.mapError(failure));
    const tool = "business_os.workjet_worker_dispatch";
    if (args.action === "register_source")
      yield* dependencies.transport.probe(target, [tool]).pipe(Effect.mapError(failure));
    const response = yield* dependencies.transport
      .callTool(target, tool, args)
      .pipe(Effect.mapError(failure));
    if (response.isError || response.structuredContent === undefined) return yield* failure();
    return response.structuredContent;
  });
  return {
    register: Effect.fn("CtoxNativeSupervisorWorkers.register")(function* (
      scope: RemoteWorkerNativeScope,
      source: NativeSupervisorSource,
    ) {
      const receipt = yield* invoke(scope, {
        action: "register_source",
        source_environment_id: source.sourceEnvironmentId,
        source_supervisor_thread_id: source.sourceSupervisorThreadId,
        project_id: source.projectId,
      }).pipe(Effect.flatMap(decodeRegistration), Effect.mapError(failure));
      if (!sameSource(receipt, source) || receipt.sourceInstanceId !== scope.instanceId)
        return yield* failure();
      return receipt;
    }),
    poll: Effect.fn("CtoxNativeSupervisorWorkers.poll")(function* (
      scope: RemoteWorkerNativeScope,
      sourceEnvironmentId: EnvironmentId,
    ) {
      const receipt = yield* invoke(scope, {
        action: "poll",
        source_environment_id: sourceEnvironmentId,
      }).pipe(Effect.flatMap(decodePoll), Effect.mapError(failure));
      if (receipt.intents.some((intent) => intent.sourceEnvironmentId !== sourceEnvironmentId))
        return yield* failure();
      return receipt.intents;
    }),
    complete: Effect.fn("CtoxNativeSupervisorWorkers.complete")(function* (
      scope: RemoteWorkerNativeScope,
      registration: NativeSupervisorSourceRegistration,
      intent: NativeSupervisorWorkerIntent,
      result: NativeSupervisorWorkerCompletion,
    ) {
      if (
        !sameSource(registration, intent) ||
        registration.registrationId !== intent.registrationId ||
        registration.revision !== intent.registrationRevision
      )
        return yield* failure();
      if (
        result.status === "dispatched" &&
        (result.workerThreadId !== intent.intentId ||
          result.parent.environmentId !== registration.sourceEnvironmentId ||
          result.parent.threadId !== registration.sourceSupervisorThreadId)
      )
        return yield* failure();
      const receipt = yield* invoke(scope, {
        action: "complete",
        registration_id: registration.registrationId,
        revision: registration.revision,
        intent_id: intent.intentId,
        result: yield* Schema.encodeEffect(NativeSupervisorWorkerCompletion)(result).pipe(
          Effect.mapError(failure),
        ),
      }).pipe(Effect.flatMap(decodeComplete), Effect.mapError(failure));
      if (
        receipt.registrationId !== registration.registrationId ||
        receipt.revision !== registration.revision ||
        receipt.intentId !== intent.intentId
      )
        return yield* failure();
    }),
  };
}
