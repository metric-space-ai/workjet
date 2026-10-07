// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics globalFetch:off -- Worker-scoped loopback protocol adapter; Effect owns cancellation and startup failure.
import { RemoteWorkerDispatchError, RemoteWorkerSourceRoute, WorkjetGatewayModelBinding, type RemoteWorkerRequest } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Semaphore from "effect/Semaphore";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { RemoteWorkerTargetHarnessSetup } from "./RemoteWorkerConnectionBootstrap.ts";
import { remoteWorkerRequestDigest } from "./ctox/CtoxRemoteWorkerAdmission.ts";
import { installWorkerSourceRoute } from "./WorkerSourceHarness.ts";

const failure = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });
const encode = Schema.encodeSync(Schema.UnknownFromJsonString);
export const targetWorkerBindingMatches = (
  binding: WorkjetGatewayModelBinding,
  request: Pick<RemoteWorkerRequest, "computerId" | "parent" | "modelSelection">,
): boolean => binding.target.computerId === request.computerId &&
  binding.credentialRef.environmentId === request.parent.environmentId &&
  binding.providerRef.environmentId === request.parent.environmentId &&
  binding.modelRef.environmentId === request.parent.environmentId &&
  binding.modelRef.provider === binding.providerRef.provider && binding.modelRef.modelId === request.modelSelection.model;

export const make = Effect.gen(function* () {
  const targetEnvironmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
  const mutex = yield* Semaphore.make(1);
  const install = Effect.fn("RemoteWorkerTargetHarnessSetup.install")(function* (
    request: RemoteWorkerRequest,
    input: RemoteWorkerSourceRoute,
  ) {
    const route = yield* Schema.decodeUnknownEffect(RemoteWorkerSourceRoute)(input).pipe(Effect.mapError(failure));
    const requestDigest = yield* remoteWorkerRequestDigest(request);
    const now = yield* Clock.currentTimeMillis;
    if (route.sourceEnvironmentId !== request.parent.environmentId || route.targetEnvironmentId !== targetEnvironmentId ||
      request.targetEnvironmentId !== targetEnvironmentId || route.requestId !== request.requestId || route.requestDigest !== requestDigest || Date.parse(request.expiresAt) <= now)
      return yield* failure();
    const binding = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`http://127.0.0.1:${route.port}/worker-source`, {
          method: "POST", signal,
          headers: { authorization: `Bearer ${route.capability}`, "content-type": "application/json" },
          body: encode({ sourceEnvironmentId: route.sourceEnvironmentId, targetEnvironmentId: route.targetEnvironmentId,
            requestId: route.requestId, requestDigest: route.requestDigest, operation: "bindModel", payload: {} }),
        });
        if (!response.ok || !response.body) throw failure();
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 64 * 1024) { await reader.cancel(); throw failure(); }
          chunks.push(next.value);
        }
        return Schema.decodeUnknownSync(Schema.fromJsonString(WorkjetGatewayModelBinding))(Buffer.concat(chunks).toString("utf8"));
      }, catch: failure,
    }).pipe(Effect.timeout("15 seconds"), Effect.mapError(failure));
    if (!targetWorkerBindingMatches(binding, request)) return yield* failure();
    yield* Effect.tryPromise({
      try: () => installWorkerSourceRoute(request.requestId, route, { targetEnvironmentId, requestDigest, modelId: binding.modelRef.modelId }),
      catch: failure,
    }).pipe(Effect.timeout("15 seconds"), Effect.mapError(failure));
  });
  return RemoteWorkerTargetHarnessSetup.of({ install: (request, route) => mutex.withPermit(install(request, route)) });
});
export const layer = Layer.effect(RemoteWorkerTargetHarnessSetup, make);
