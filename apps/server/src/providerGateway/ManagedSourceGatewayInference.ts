import { WorkjetGatewayInferenceError, type EnvironmentId } from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import type { ServerSettingsService } from "../serverSettings.ts";
import type { DecisionHubConnectionRegistryShape } from "../workjet/decisionHub/DecisionHubConnectionRegistry.ts";
import { makeCtoxMcpTransport } from "../workjet/ctox/CtoxMcpTransport.ts";
import { makeCtoxRemoteWorkerAdmissionClient } from "../workjet/ctox/CtoxRemoteWorkerAdmission.ts";
import type { ProviderGatewayServiceShape } from "./ProviderGatewayService.ts";
import { forwardSourceGatewayResponses, forwardSourceGatewayProtocol } from "./ProviderGatewayNodeAdapter.ts";
import { makeSourceGatewayInference } from "./SourceGatewayInference.ts";

/** Source-process constructor shared by authenticated RPC and the managed worker bridge.
 * It resolves current native authority on every call; no credential is returned. */
export function makeManagedSourceGatewayInference(dependencies: {
  readonly environmentId: Effect.Effect<EnvironmentId>;
  readonly settings: Pick<ServerSettingsService["Service"], "getSettings">;
  readonly gateway: Pick<ProviderGatewayServiceShape, "scopedCatalog" | "status">;
  readonly connections: Pick<DecisionHubConnectionRegistryShape, "resolveReadyTarget"> | undefined;
}) {
  const failure = (reason: WorkjetGatewayInferenceError["reason"]) =>
    new WorkjetGatewayInferenceError({ reason });
  return makeSourceGatewayInference({
    environmentId: dependencies.environmentId,
    configuration: dependencies.settings.getSettings.pipe(
      Effect.map((settings) => settings.workjet),
      Effect.mapError(() => failure("binding-mismatch")),
    ),
    requireSourceInstance: (instanceId) =>
      dependencies.settings.getSettings.pipe(
        Effect.mapError(() => failure("binding-mismatch")),
        Effect.flatMap((settings) => {
          const instance = settings.providerInstances[instanceId];
          return instance && instance.enabled !== false
            ? Effect.void
            : Effect.fail(failure("binding-mismatch"));
        }),
      ),
    // Preserve the exact native target tuple, which can differ from the UI row.
    scopedCatalog: (target, environmentId) =>
      dependencies.gateway
        .scopedCatalog(target, environmentId)
        .pipe(Effect.mapError(() => failure("grant-unavailable"))),
    revalidate: (input) =>
      Effect.gen(function* () {
        if (dependencies.connections === undefined)
          return yield* failure("native-admission-unavailable");
        const admission = makeCtoxRemoteWorkerAdmissionClient({
          connections: dependencies.connections,
          gateway: dependencies.gateway,
          transport: makeCtoxMcpTransport(yield* HttpClient.HttpClient),
        });
        return yield* admission
          .execute(
            {
              connectionId: input.sourceConnectionId,
              instanceId: input.permit.binding.sourceInstanceId,
            },
            input.workerRequest,
            input.permit.binding,
            "revalidate",
            input.permit.permitId,
            input.permit.executionId,
          )
          .pipe(
            Effect.mapError((error) =>
              failure(
                error.reason === "source-unavailable"
                  ? "native-admission-unavailable"
                  : "native-admission-rejected",
              ),
            ),
          );
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    forward: (selected, requestJson, deadlineMs, protocol) =>
      Effect.gen(function* () {
        const status = yield* dependencies.gateway.status();
        if (status.phase !== "ready" || status.providerEndpoint === null)
          return yield* failure("gateway-unavailable");
        return yield* Effect.tryPromise({
          try: (signal) =>
            forwardSourceGatewayResponses(
              status.providerEndpoint!,
              selected,
              requestJson,
              deadlineMs,
              signal,
              protocol,
            ),
          catch: () => failure("inference-failed"),
        });
      }),
    forwardProtocol: (selected, requestJson, deadlineMs, protocol) =>
      Effect.gen(function* () {
        const status = yield* dependencies.gateway.status();
        if (status.phase !== "ready" || status.providerEndpoint === null)
          return yield* failure("gateway-unavailable");
        return yield* Effect.tryPromise({
          try: (signal) => forwardSourceGatewayProtocol(status.providerEndpoint!, selected, requestJson, deadlineMs, protocol, signal),
          catch: () => failure("inference-failed"),
        });
      }),
    now: Clock.currentTimeMillis,
  });
}
