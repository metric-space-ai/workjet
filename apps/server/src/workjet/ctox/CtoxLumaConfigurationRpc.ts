import type { WorkjetConfiguration, WorkjetLumaTarget } from "@workjet/contracts";
import {
  WorkjetLumaConfigurationError,
  WorkjetLumaInstanceConfiguration,
  WorkjetLumaSnapshot,
  WorkjetLumaUpdateInput,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import type { makeCtoxLumaConfigurationClient } from "./CtoxLumaConfigurationClient.ts";

/** Resolve the authenticated, instance-pinned connection on every operation.
 * Computer selection and renderer-supplied credentials never select authority. */
export function makeCtoxLumaConfigurationRpc(dependencies: {
  readonly connections: Pick<DecisionHubConnectionRegistry["Service"], "resolveReadyTarget">;
  readonly client: ReturnType<typeof makeCtoxLumaConfigurationClient>;
}) {
  const target = (scope: WorkjetLumaTarget) =>
    dependencies.connections.resolveReadyTarget(scope.connectionId, scope.instanceId).pipe(
      Effect.mapError(() => new WorkjetLumaConfigurationError({ reason: "connection-unavailable" })),
    );
  const invalid = () => new WorkjetLumaConfigurationError({ reason: "remote-response-invalid" });
  const remoteFailure = (error: { readonly reason: string }) =>
    new WorkjetLumaConfigurationError({
      reason: error.reason === "connection-unavailable" ? "connection-unavailable" : "remote-response-invalid",
    });
  const read = Effect.fn("CtoxLumaConfigurationRpc.read")(function* (scope: WorkjetLumaTarget) {
    const resolved = yield* target(scope);
    const result = yield* dependencies.client.read(resolved).pipe(Effect.mapError(remoteFailure));
    return yield* Schema.decodeUnknownEffect(WorkjetLumaSnapshot)(result).pipe(Effect.mapError(invalid));
  });
  return {
    read,
    update: Effect.fn("CtoxLumaConfigurationRpc.update")(function* (input: typeof WorkjetLumaUpdateInput.Type) {
      const resolved = yield* target(input.target);
      return yield* dependencies.client.save(resolved, input.expectedRevision, input.configuration)
        .pipe(Effect.mapError(remoteFailure));
    }),
    /** Apply shared Luma definitions at dispatch time, while retaining this
     * computer's enrollment and selection. Never persist an instance into a
     * machine settings file or fall back to another instance on a read error. */
    resolveDispatch: Effect.fn("CtoxLumaConfigurationRpc.resolveDispatch")(function* (
      scope: WorkjetLumaTarget,
      local: WorkjetConfiguration,
    ) {
      const snapshot = yield* read(scope);
      if (snapshot.revision === 0 && snapshot.configuration === null) return local;
      if (snapshot.configuration === null) return yield* invalid();
      const shared = yield* Schema.decodeUnknownEffect(WorkjetLumaInstanceConfiguration)(
        snapshot.configuration,
      ).pipe(Effect.mapError(invalid));
      return { ...local, ...shared };
    }),
  };
}
