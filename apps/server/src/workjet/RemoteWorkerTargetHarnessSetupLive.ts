// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  RemoteWorkerDispatchError,
  RemoteWorkerSourceRoute,
  WorkjetGatewayModelBinding,
  type RemoteWorkerRequest,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerConfig } from "../config.ts";
import * as Path from "effect/Path";
import { RemoteWorkerTargetHarnessSetup } from "./RemoteWorkerConnectionBootstrap.ts";
import { remoteWorkerRequestDigest } from "./ctox/CtoxRemoteWorkerAdmission.ts";
import { installWorkerSourceRoute } from "./WorkerSourceHarness.ts";

const failure = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });
export const targetWorkerBindingMatches = (
  binding: WorkjetGatewayModelBinding,
  request: Pick<RemoteWorkerRequest, "computerId" | "parent" | "modelSelection">,
): boolean =>
  binding.target.computerId === request.computerId &&
  binding.credentialRef.environmentId === request.parent.environmentId &&
  binding.providerRef.environmentId === request.parent.environmentId &&
  binding.modelRef.environmentId === request.parent.environmentId &&
  binding.modelRef.provider === binding.providerRef.provider &&
  binding.modelRef.modelId === request.modelSelection.model;

export const make = Effect.gen(function* () {
  const targetEnvironmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
  const server = yield* ServerConfig;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const mutex = yield* Semaphore.make(1);
  const install = Effect.fn("RemoteWorkerTargetHarnessSetup.install")(function* (
    request: RemoteWorkerRequest,
    input: RemoteWorkerSourceRoute,
  ) {
    const route = yield* Schema.decodeUnknownEffect(RemoteWorkerSourceRoute)(input).pipe(
      Effect.mapError(failure),
    );
    const requestDigest = yield* remoteWorkerRequestDigest(request);
    const now = yield* Clock.currentTimeMillis;
    if (
      route.sourceEnvironmentId !== request.parent.environmentId ||
      route.targetEnvironmentId !== targetEnvironmentId ||
      request.targetEnvironmentId !== targetEnvironmentId ||
      route.requestId !== request.requestId ||
      route.requestDigest !== requestDigest ||
      Date.parse(request.expiresAt) <= now
    )
      return yield* failure();
    const binding = yield* Effect.gen(function* () {
      const response = yield* http.execute(
        HttpClientRequest.post(`http://127.0.0.1:${route.port}/worker-source`).pipe(
          HttpClientRequest.bearerToken(route.capability),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({
            sourceEnvironmentId: route.sourceEnvironmentId,
            targetEnvironmentId: route.targetEnvironmentId,
            requestId: route.requestId,
            requestDigest: route.requestDigest,
            operation: "bindModel",
            payload: {},
          }),
        ),
      );
      if (response.status !== 200) return yield* failure();
      const body = yield* response.text;
      if (new TextEncoder().encode(body).byteLength > 64 * 1024) return yield* failure();
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorkjetGatewayModelBinding))(
        body,
      );
    }).pipe(Effect.scoped, Effect.timeout("15 seconds"), Effect.mapError(failure));
    if (!targetWorkerBindingMatches(binding, request)) return yield* failure();
    yield* Effect.tryPromise({
      try: () =>
        installWorkerSourceRoute(request.requestId, route, {
          targetEnvironmentId,
          requestDigest,
          modelId: binding.modelRef.modelId,
          harness: request.harness ?? "codex-cli",
          ...(request.harness === undefined || request.harness === "codex-cli" || request.harness === "claude-code" ? {} : { nativeProfile: { harness: request.harness, directory: path.join(server.stateDir, "worker-source-profiles", requestDigest) } }),
        }),
      catch: failure,
    }).pipe(Effect.timeout("15 seconds"), Effect.mapError(failure));
  });
  return RemoteWorkerTargetHarnessSetup.of({
    install: (request, route) => mutex.withPermit(install(request, route)),
  });
});
export const layer = Layer.effect(RemoteWorkerTargetHarnessSetup, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
