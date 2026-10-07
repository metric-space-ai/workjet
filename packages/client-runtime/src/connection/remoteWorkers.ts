import {
  RemoteWorkerDispatchError,
  WS_METHODS,
  type EnvironmentId,
  type RemoteWorkerRequest,
  type RemoteWorkerResponse,
  type RemoteWorkerSourceProfile,
  type RemoteWorkerRouteReservation,
  type RemoteWorkerRouteProof,
  type RemoteWorkerSourceRoute,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentRegistry } from "./registry.ts";
import * as Option from "effect/Option";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { request, subscribe } from "../rpc/client.ts";

export class RemoteWorkerRelayUnavailable extends Schema.TaggedErrorClass<RemoteWorkerRelayUnavailable>()(
  "RemoteWorkerRelayUnavailable",
  {},
) {}

export interface RemoteWorkerRelayPort {
  readonly receive: (
    input: RemoteWorkerRequest,
  ) => Effect.Effect<RemoteWorkerResponse["outcome"], RemoteWorkerRelayUnavailable>;
  readonly respond: (
    source: EnvironmentId,
    response: RemoteWorkerResponse,
  ) => Effect.Effect<void, RemoteWorkerRelayUnavailable>;
}

/** A disconnect leaves the source request pending. The target deduplicates the
 * exact request ID, including a reply lost during a full desktop restart. */
export const relayRemoteWorker = Effect.fn("RemoteWorkers.relay")(function* (
  sourceEnvironmentId: EnvironmentId,
  input: RemoteWorkerRequest,
  port: RemoteWorkerRelayPort,
) {
  if (
    input.parent.environmentId !== sourceEnvironmentId ||
    input.targetEnvironmentId === sourceEnvironmentId
  )
    return;
  const outcome = yield* port.receive(input);
  yield* port.respond(sourceEnvironmentId, { requestId: input.requestId, outcome });
});

export const registeredWorkerSshProfile = (
  entry: ConnectionCatalogEntry | undefined,
  targetEnvironmentId: EnvironmentId,
): Effect.Effect<RemoteWorkerSourceProfile, RemoteWorkerRelayUnavailable> => {
  if (!entry || entry.target._tag !== "SshConnectionTarget" || Option.isNone(entry.profile) ||
    entry.profile.value._tag !== "SshConnectionProfile" || entry.target.environmentId !== targetEnvironmentId ||
    entry.profile.value.environmentId !== targetEnvironmentId || entry.target.connectionId !== entry.profile.value.connectionId)
    return Effect.fail(new RemoteWorkerRelayUnavailable({}));
  return Effect.succeed({ connectionId: entry.profile.value.connectionId, environmentId: targetEnvironmentId,
    target: entry.profile.value.target });
};

export interface RemoteWorkerBootstrapPort {
  readonly reserve: Effect.Effect<RemoteWorkerRouteReservation, RemoteWorkerRelayUnavailable>;
  readonly prepare: (reservation: RemoteWorkerRouteReservation) => Effect.Effect<RemoteWorkerSourceRoute, RemoteWorkerRelayUnavailable>;
  readonly verify: (reservation: RemoteWorkerRouteReservation, route: RemoteWorkerSourceRoute) => Effect.Effect<RemoteWorkerRouteProof, RemoteWorkerRelayUnavailable>;
  readonly confirm: (proof: RemoteWorkerRouteProof) => Effect.Effect<void, RemoteWorkerRelayUnavailable>;
}
export const bootstrapWorkerSource = Effect.fn("RemoteWorkers.bootstrapWorkerSource")(function* (port: RemoteWorkerBootstrapPort) {
  const reservation = yield* port.reserve;
  const route = yield* port.prepare(reservation);
  const proof = yield* port.verify(reservation, route);
  yield* port.confirm(proof);
});

export const startup = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry;
  const port: RemoteWorkerRelayPort = {
    receive: (input) =>
      Effect.gen(function* () {
        // Resolve only registered connections. The connection broker owns SSH,
        // DPoP and credential refresh; no addresses or secrets come from the task.
        const entries = yield* SubscriptionRef.get(registry.entries);
        const profile = yield* registeredWorkerSshProfile(entries.get(input.targetEnvironmentId), input.targetEnvironmentId);
        const config = yield* registry.run(
          input.targetEnvironmentId,
          request(WS_METHODS.serverGetConfig, {}),
        );
        if (!config.environment.capabilities.remoteWorkerDispatch || config.environment.environmentId !== input.targetEnvironmentId)
          return yield* new RemoteWorkerRelayUnavailable({});
        const unavailable = () => new RemoteWorkerRelayUnavailable({});
        yield* bootstrapWorkerSource({
          reserve: registry.run(input.targetEnvironmentId, request(WS_METHODS.workjetWorkerRouteReserve, input)).pipe(Effect.mapError(unavailable)),
          prepare: (reservation) => registry.run(input.parent.environmentId,
            request(WS_METHODS.workjetWorkerSourcePrepare, { workerRequest: input, profile, reservation })).pipe(Effect.mapError(unavailable)),
          verify: (reservation, route) => registry.run(input.targetEnvironmentId,
            request(WS_METHODS.workjetWorkerRouteVerify, { workerRequest: input, reservation, route })).pipe(Effect.mapError(unavailable)),
          confirm: (proof) => registry.run(input.parent.environmentId,
            request(WS_METHODS.workjetWorkerSourceConfirm, proof)).pipe(Effect.mapError(unavailable)),
        });
        const received = yield* Effect.result(
          registry.run(input.targetEnvironmentId, request(WS_METHODS.workjetWorkerReceive, input)),
        );
        if (Result.isSuccess(received))
          return { status: "dispatched", result: received.success } as const;
        // Explicit native rejection is durable; transport/auth loss is retried
        // with the same ID after the registered connection recovers.
        if (Schema.is(RemoteWorkerDispatchError)(received.failure)) {
          return { status: "failed", reason: received.failure.reason } as const;
        }
        return yield* new RemoteWorkerRelayUnavailable({});
      }).pipe(Effect.catch(() => Effect.fail(new RemoteWorkerRelayUnavailable({})))),
    respond: (source, response) =>
      registry
        .run(source, request(WS_METHODS.workjetWorkerRespond, response))
        .pipe(Effect.catch(() => Effect.fail(new RemoteWorkerRelayUnavailable({})))),
  };
  yield* SubscriptionRef.changes(registry.entries).pipe(
    Stream.switchMap((entries) =>
      Stream.mergeAll(
        [...entries.keys()].map((source) =>
          registry
            .followStream(
              source,
              subscribe(WS_METHODS.subscribeServerConfig, {}).pipe(
                Stream.switchMap((config) =>
                  config.environment.capabilities.remoteWorkerDispatch
                    ? subscribe(WS_METHODS.workjetWorkerRequests, {})
                    : Stream.empty,
                ),
              ),
            )
            .pipe(
              Stream.mapEffect((requests) =>
                Effect.forEach(
                  requests,
                  (input) =>
                    relayRemoteWorker(source, input, port).pipe(Effect.exit, Effect.asVoid),
                  { concurrency: 1, discard: true },
                ),
              ),
              Stream.catch(() => Stream.empty),
            ),
        ),
        { concurrency: "unbounded" },
      ),
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );
});
export const startupLayer = Layer.effectDiscard(startup);
