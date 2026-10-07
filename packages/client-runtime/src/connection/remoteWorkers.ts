import { RemoteWorkerDispatchError, WS_METHODS, type EnvironmentId, type RemoteWorkerRequest, type RemoteWorkerResponse } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentRegistry } from "./registry.ts";
import { request, subscribe } from "../rpc/client.ts";

export class RemoteWorkerRelayUnavailable extends Schema.TaggedErrorClass<RemoteWorkerRelayUnavailable>()(
  "RemoteWorkerRelayUnavailable", {},
) {}

export interface RemoteWorkerRelayPort {
  readonly receive: (input: RemoteWorkerRequest) => Effect.Effect<RemoteWorkerResponse["outcome"], RemoteWorkerRelayUnavailable>;
  readonly respond: (source: EnvironmentId, response: RemoteWorkerResponse) => Effect.Effect<void, RemoteWorkerRelayUnavailable>;
}

/** A disconnect leaves the source request pending. The target deduplicates the
 * exact request ID, including a reply lost during a full desktop restart. */
export const relayRemoteWorker = Effect.fn("RemoteWorkers.relay")(function* (
  sourceEnvironmentId: EnvironmentId,
  input: RemoteWorkerRequest,
  port: RemoteWorkerRelayPort,
) {
  if (input.parent.environmentId !== sourceEnvironmentId || input.targetEnvironmentId === sourceEnvironmentId) return;
  const outcome = yield* port.receive(input);
  yield* port.respond(sourceEnvironmentId, { requestId: input.requestId, outcome });
});

export const startup = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry;
  const port: RemoteWorkerRelayPort = {
    receive: (input) => Effect.gen(function* () {
      // Resolve only registered connections. The connection broker owns SSH,
      // DPoP and credential refresh; no addresses or secrets come from the task.
      const entries = yield* SubscriptionRef.get(registry.entries);
      if (!entries.has(input.targetEnvironmentId)) return yield* new RemoteWorkerRelayUnavailable({});
      const config = yield* registry.run(input.targetEnvironmentId, request(WS_METHODS.serverGetConfig, {}));
      if (!config.environment.capabilities.remoteWorkerDispatch) return yield* new RemoteWorkerRelayUnavailable({});
      const received = yield* Effect.result(registry.run(
        input.targetEnvironmentId, request(WS_METHODS.workjetWorkerReceive, input),
      ));
      if (Result.isSuccess(received)) return { status: "dispatched", result: received.success } as const;
      // Explicit native rejection is durable; transport/auth loss is retried
      // with the same ID after the registered connection recovers.
      if (Schema.is(RemoteWorkerDispatchError)(received.failure)) {
        return { status: "failed", reason: received.failure.reason } as const;
      }
      return yield* new RemoteWorkerRelayUnavailable({});
    }).pipe(Effect.catch(() => Effect.fail(new RemoteWorkerRelayUnavailable({})))),
    respond: (source, response) => registry.run(source, request(WS_METHODS.workjetWorkerRespond, response)).pipe(
      Effect.catch(() => Effect.fail(new RemoteWorkerRelayUnavailable({}))),
    ),
  };
  yield* SubscriptionRef.changes(registry.entries).pipe(
    Stream.switchMap((entries) => Stream.mergeAll(
      [...entries.keys()].map((source) => registry.followStream(source,
        subscribe(WS_METHODS.subscribeServerConfig, {}).pipe(Stream.switchMap((config) =>
          config.environment.capabilities.remoteWorkerDispatch
            ? subscribe(WS_METHODS.workjetWorkerRequests, {})
            : Stream.empty,
        )),
      ).pipe(
        Stream.mapEffect((requests) => Effect.forEach(requests, (input) =>
          relayRemoteWorker(source, input, port).pipe(Effect.exit, Effect.asVoid),
          { concurrency: 1, discard: true },
        )),
        Stream.catch(() => Stream.empty),
      )),
      { concurrency: "unbounded" },
    )),
    Stream.runDrain,
    Effect.forkScoped,
  );
});
export const startupLayer = Layer.effectDiscard(startup);
