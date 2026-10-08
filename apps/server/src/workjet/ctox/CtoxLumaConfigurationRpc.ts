import type { WorkjetLumaTarget } from "@workjet/contracts";
import { WorkjetLumaConfigurationError, WorkjetLumaSnapshot, WorkjetLumaUpdateInput } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import type { makeCtoxLumaConfigurationClient } from "./CtoxLumaConfigurationClient.ts";

/** Resolve the existing authenticated, instance-pinned connection on every call.
 * Neither a computer selection nor renderer-supplied credentials select authority. */
export function makeCtoxLumaConfigurationRpc(dependencies: {
  readonly connections: Pick<DecisionHubConnectionRegistry["Service"], "resolveReadyTarget">;
  readonly client: ReturnType<typeof makeCtoxLumaConfigurationClient>;
}) {
  const target = (scope: WorkjetLumaTarget) => dependencies.connections
    .resolveReadyTarget(scope.connectionId, scope.instanceId)
    .pipe(Effect.mapError(() => new WorkjetLumaConfigurationError({ reason: "connection-unavailable" })));
  const invalid = () => new WorkjetLumaConfigurationError({ reason: "remote-response-invalid" });
  return {
    read: Effect.fn("CtoxLumaConfigurationRpc.read")(function* (scope: WorkjetLumaTarget) {
      const resolved = yield* target(scope);
      const result = yield* dependencies.client.read(resolved).pipe(Effect.mapError(invalid));
      return yield* Schema.decodeUnknownEffect(WorkjetLumaSnapshot)(result).pipe(Effect.mapError(invalid));
    }),
    update: Effect.fn("CtoxLumaConfigurationRpc.update")(function* (input: typeof WorkjetLumaUpdateInput.Type) {
      const resolved = yield* target(input.target);
      return yield* dependencies.client.save(resolved, input.expectedRevision, input.configuration)
        .pipe(Effect.mapError(invalid));
    }),
  };
}
