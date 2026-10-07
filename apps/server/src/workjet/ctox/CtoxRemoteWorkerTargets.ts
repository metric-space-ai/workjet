// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeUtil from "node:util";
import { RemoteWorkerDispatchError, type EnvironmentId, type RemoteWorkerComputerEnrollmentInput } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import type { makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import type { RemoteWorkerNativeScope } from "./CtoxRemoteWorkerAdmission.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const RemoteWorkerNativeTarget = Schema.Struct({
  sourceEnvironmentId: Id, targetEnvironmentId: Id,
  targetConnectionId: Id, targetInstanceId: Id, targetComputerId: Id,
});
export type RemoteWorkerNativeTarget = typeof RemoteWorkerNativeTarget.Type;
export const RemoteWorkerNativeTargetReceipt = Schema.Struct({
  contract: Schema.Literal("ctox.workjet.remote-worker-target.v1"),
  bindingId: Id, revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  ownerUserId: Id, sourceInstanceId: Id, target: RemoteWorkerNativeTarget,
  state: Schema.Literals(["active", "revoked"]),
  capabilityEpoch: Schema.Int,
  // Native validates the typed build configuration on every positive action.
  // This opaque snapshot is not used as a local readiness/admission decision.
  buildCapability: Schema.Unknown,
});
export type RemoteWorkerNativeTargetReceipt = typeof RemoteWorkerNativeTargetReceipt.Type;
const failure = (reason: RemoteWorkerDispatchError["reason"]) => new RemoteWorkerDispatchError({ reason });

export function makeCtoxRemoteWorkerTargets(dependencies: {
  readonly connections: Pick<DecisionHubConnectionRegistry["Service"], "resolveReadyTarget">;
  readonly transport: ReturnType<typeof makeCtoxMcpTransport>;
}) {
  const execute = Effect.fn("CtoxRemoteWorkerTargets.execute")(function* (
    scope: RemoteWorkerNativeScope, sourceEnvironmentId: EnvironmentId,
    targetEnvironmentId: EnvironmentId, args: Record<string, unknown>,
  ) {
    if (sourceEnvironmentId === targetEnvironmentId) return yield* failure("invalid-request");
    const source = yield* dependencies.connections.resolveReadyTarget(scope.connectionId, scope.instanceId)
      .pipe(Effect.mapError(() => failure("source-unavailable")));
    const tool = "business_os.remote_worker_admission";
    yield* dependencies.transport.probe(source, [tool])
      .pipe(Effect.mapError(() => failure("source-unavailable")));
    const response = yield* dependencies.transport.callTool(source, tool, args)
      .pipe(Effect.mapError(() => failure("source-unavailable")));
    if (response.isError || response.structuredContent === undefined) return yield* failure("computer-unavailable");
    const receipt = yield* Schema.decodeUnknownEffect(RemoteWorkerNativeTargetReceipt)(response.structuredContent)
      .pipe(Effect.mapError(() => failure("invalid-request")));
    if (receipt.sourceInstanceId !== scope.instanceId ||
      receipt.target.sourceEnvironmentId !== sourceEnvironmentId ||
      receipt.target.targetEnvironmentId !== targetEnvironmentId ||
      (args.action === "revoke_target" ? receipt.state !== "revoked" : receipt.state !== "active"))
      return yield* failure("invalid-request");
    return receipt;
  });
  return {
    enroll: Effect.fn("CtoxRemoteWorkerTargets.enroll")(function* (
      scope: RemoteWorkerNativeScope, source: EnvironmentId, target: EnvironmentId,
      assignment: Pick<RemoteWorkerNativeTarget, "targetConnectionId" | "targetInstanceId">,
      computer: Pick<RemoteWorkerComputerEnrollmentInput, "displayName" | "hostingMode" | "buildCapability">,
    ) {
      const { kind: _kind, ...buildCapability } = computer.buildCapability;
      const receipt = yield* execute(scope, source, target, {
        action: "enroll_target",
        target: { sourceEnvironmentId: source, targetEnvironmentId: target, ...assignment },
        computer: { displayName: computer.displayName, hostingMode: computer.hostingMode, buildCapability },
      });
      if (receipt.target.targetConnectionId !== assignment.targetConnectionId ||
        receipt.target.targetInstanceId !== assignment.targetInstanceId ||
        !NodeUtil.isDeepStrictEqual(receipt.buildCapability, { kind: "build", ...buildCapability }))
        return yield* failure("invalid-request");
      return receipt;
    }),
    resolve: (scope: RemoteWorkerNativeScope, source: EnvironmentId, target: EnvironmentId) =>
      execute(scope, source, target, { action: "resolve_target", target_environment_id: target }),
    register: Effect.fn("CtoxRemoteWorkerTargets.register")(function* (
      scope: RemoteWorkerNativeScope, source: EnvironmentId, target: EnvironmentId,
      assignment: RemoteWorkerNativeTarget, expectedRevision?: number,
    ) {
      if (assignment.sourceEnvironmentId !== source || assignment.targetEnvironmentId !== target)
        return yield* failure("invalid-request");
      const receipt = yield* execute(scope, source, target, {
        action: "register_target", target: assignment,
        ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
      });
      if (!NodeUtil.isDeepStrictEqual(receipt.target, assignment)) return yield* failure("invalid-request");
      return receipt;
    }),
    revoke: Effect.fn("CtoxRemoteWorkerTargets.revoke")(function* (
      scope: RemoteWorkerNativeScope, source: EnvironmentId, target: EnvironmentId, expectedRevision: number,
    ) {
      if (source === target) return yield* failure("invalid-request");
      const upstream = yield* dependencies.connections.resolveReadyTarget(scope.connectionId, scope.instanceId)
        .pipe(Effect.mapError(() => failure("source-unavailable")));
      const tool = "business_os.remote_worker_admission";
      yield* dependencies.transport.probe(upstream, [tool]).pipe(Effect.mapError(() => failure("source-unavailable")));
      const response = yield* dependencies.transport.callTool(upstream, tool, {
        action: "revoke_target", target_environment_id: target, expected_revision: expectedRevision,
      }).pipe(Effect.mapError(() => failure("source-unavailable")));
      if (response.isError || response.structuredContent === undefined) return yield* failure("computer-unavailable");
      // Native revocation deliberately returns no positive build/admission data.
      const receipt = yield* Schema.decodeUnknownEffect(Schema.Struct({
        contract: Schema.Literal("ctox.workjet.remote-worker-target.v1"), bindingId: Id,
        revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), ownerUserId: Id,
        sourceInstanceId: Id, target: RemoteWorkerNativeTarget, state: Schema.Literal("revoked"),
      }))(response.structuredContent).pipe(Effect.mapError(() => failure("invalid-request")));
      if (receipt.sourceInstanceId !== scope.instanceId || receipt.target.sourceEnvironmentId !== source ||
        receipt.target.targetEnvironmentId !== target) return yield* failure("invalid-request");
      return receipt;
    }),
  };
}
