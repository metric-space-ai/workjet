// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off -- Service-owned SSH bootstrap and loopback verification.
import * as Crypto from "node:crypto";
import * as Net from "node:net";
import * as Fs from "node:fs/promises";
import {
  RemoteWorkerDispatchError,
  RemoteWorkerSourceRoute,
  RemoteWorkerSourceProfile,
  type RemoteWorkerRequest,
  type RemoteWorkerRouteReservation,
  type RemoteWorkerRouteProof,
  RemoteWorkerSourcePrepareInput,
  RemoteWorkerTargetRouteInput,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { RemoteWorkerBroker } from "./RemoteWorkerBroker.ts";
import { remoteWorkerRequestDigest } from "./ctox/CtoxRemoteWorkerAdmission.ts";
import { openManagedWorkerSourceConnection } from "./RemoteWorkerSourceConnection.ts";
import type { WorkerSourceOperation } from "./RemoteWorkerSourceChannel.ts";

export class RemoteWorkerSourceOperations extends Context.Service<
  RemoteWorkerSourceOperations,
  {
    readonly authorize: (
      request: RemoteWorkerRequest,
      profile: RemoteWorkerSourceProfile,
    ) => Effect.Effect<void, RemoteWorkerDispatchError>;
    readonly invoke: (
      request: RemoteWorkerRequest,
      operation: WorkerSourceOperation,
      payload: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>;
  }
>()("workjet/workjet/RemoteWorkerConnectionBootstrap/RemoteWorkerSourceOperations") {}

export class RemoteWorkerTargetHarnessSetup extends Context.Service<
  RemoteWorkerTargetHarnessSetup,
  {
    readonly install: (
      request: RemoteWorkerRequest,
      route: RemoteWorkerSourceRoute,
    ) => Effect.Effect<void, RemoteWorkerDispatchError>;
  }
>()("workjet/workjet/RemoteWorkerConnectionBootstrap/RemoteWorkerTargetHarnessSetup") {}

const failure = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });
const secretName = (kind: "profile" | "route", requestId: string) =>
  `worker-source-${kind}-${Crypto.createHash("sha256").update(requestId).digest("hex")}`;
const StoredWorkerRoute = Schema.Struct({
  requestDigest: Schema.String,
  expiresAt: Schema.String,
  route: RemoteWorkerSourceRoute,
});
const tokenDigest = (token: string) => Crypto.createHash("sha256").update(token).digest("hex");

/** A reverse tunnel is accepted only when the target kernel reports exactly an
 * IPv4 loopback LISTEN and no wildcard/IPv6 listener at that port. This catches
 * sshd GatewayPorts=yes overriding an explicitly loopback-bound -R argument. */
export const verifyLinuxWorkerLoopback = (port: number, tcp: string, tcp6: string): boolean => {
  const listeners = [tcp, tcp6].flatMap((table) =>
    table
      .split("\n")
      .slice(1)
      .flatMap((line) => {
        const columns = line.trim().split(/\s+/);
        const local = columns[1]?.split(":");
        return columns[3] === "0A" && local && Number.parseInt(local[1] ?? "", 16) === port
          ? [local[0]]
          : [];
      }),
  );
  return listeners.length === 1 && listeners[0] === "0100007F";
};
const reservePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = Net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) =>
        error
          ? reject(error)
          : typeof address === "object" && address !== null
            ? resolve(address.port)
            : reject(new Error("port")),
      );
    });
  });

export const make = Effect.gen(function* () {
  const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
  const broker = yield* RemoteWorkerBroker;
  const secrets = yield* ServerSecretStore;
  const operations = yield* Effect.serviceOption(RemoteWorkerSourceOperations);
  const targetHarness = yield* Effect.serviceOption(RemoteWorkerTargetHarnessSetup);
  const serviceScope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const runtime =
    yield* Effect.context<Effect.Services<ReturnType<typeof openManagedWorkerSourceConnection>>>();
  type SourceSession = {
    readonly digest: string;
    readonly reservation: RemoteWorkerRouteReservation;
    readonly route: RemoteWorkerSourceRoute;
    readonly proof: Deferred.Deferred<boolean>;
    readonly ready: Deferred.Deferred<void, RemoteWorkerDispatchError>;
    readonly profileDigest: string;
    readonly scope: Scope.Closeable;
    confirmed: boolean;
  };
  const sources = new Map<string, SourceSession>();
  const reservations = new Map<
    string,
    { reservation: RemoteWorkerRouteReservation; expiresAtMs: number }
  >();
  const digest = (request: RemoteWorkerRequest) => remoteWorkerRequestDigest(request);
  const current = (request: RemoteWorkerRequest) =>
    Clock.currentTimeMillis.pipe(Effect.map((now) => Date.parse(request.expiresAt) > now));

  const reserve = Effect.fn("WorkerConnection.reserve")(function* (request: RemoteWorkerRequest) {
    if (request.targetEnvironmentId !== environmentId || !(yield* current(request)))
      return yield* failure();
    const requestDigest = yield* digest(request);
    const old = reservations.get(request.requestId);
    if (old) {
      if (old.reservation.requestDigest !== requestDigest) return yield* failure();
      return old.reservation;
    }
    const now = yield* Clock.currentTimeMillis;
    for (const [id, entry] of reservations) if (entry.expiresAtMs <= now) reservations.delete(id);
    if (reservations.size >= 128) return yield* failure();
    const remotePort = yield* Effect.tryPromise({ try: reservePort, catch: failure });
    const reservation: RemoteWorkerRouteReservation = {
      bootstrapId: Crypto.randomBytes(32).toString("hex"),
      targetEnvironmentId: environmentId,
      requestId: request.requestId,
      requestDigest,
      remotePort,
    };
    reservations.set(request.requestId, {
      reservation,
      expiresAtMs: Date.parse(request.expiresAt),
    });
    return reservation;
  });

  const prepare = Effect.fn("WorkerConnection.prepare")(function* (
    input: typeof RemoteWorkerSourcePrepareInput.Type,
  ) {
    const request = input.workerRequest;
    if (
      Option.isNone(operations) ||
      request.parent.environmentId !== environmentId ||
      !(yield* current(request)) ||
      input.profile.environmentId !== request.targetEnvironmentId ||
      input.reservation.targetEnvironmentId !== request.targetEnvironmentId ||
      input.reservation.requestId !== request.requestId
    )
      return yield* failure();
    const requestDigest = yield* digest(request);
    if (input.reservation.requestDigest !== requestDigest) return yield* failure();
    const outbound = yield* broker.read(request.requestId);
    if (Option.isNone(outbound) || (yield* digest(outbound.value.request)) !== requestDigest)
      return yield* failure();
    yield* operations.value.authorize(request, input.profile);
    const profileJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(RemoteWorkerSourceProfile),
    )(input.profile).pipe(Effect.mapError(failure));
    const profileDigest = tokenDigest(profileJson);
    const old = sources.get(request.requestId);
    if (old) {
      if (
        old.digest !== requestDigest ||
        old.profileDigest !== profileDigest ||
        old.reservation.bootstrapId !== input.reservation.bootstrapId
      )
        return yield* failure();
      return old.route;
    }
    if (sources.size >= 128) return yield* failure();
    const profileBytes = new TextEncoder().encode(profileJson);
    const existing = yield* secrets
      .get(secretName("profile", request.requestId))
      .pipe(Effect.mapError(failure));
    if (
      Option.isSome(existing) &&
      new TextDecoder().decode(existing.value) !== new TextDecoder().decode(profileBytes)
    )
      return yield* new RemoteWorkerDispatchError({ reason: "request-conflict" });
    yield* secrets
      .set(secretName("profile", request.requestId), profileBytes)
      .pipe(Effect.mapError(failure));
    const retained = yield* secrets
      .get(secretName("profile", request.requestId))
      .pipe(Effect.mapError(failure));
    if (Option.isNone(retained)) return yield* failure();
    const profile = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(RemoteWorkerSourceProfile),
    )(new TextDecoder().decode(retained.value)).pipe(Effect.mapError(failure));
    const proof = yield* Deferred.make<boolean>();
    const ready = yield* Deferred.make<void, RemoteWorkerDispatchError>();
    const published = yield* Deferred.make<RemoteWorkerSourceRoute, RemoteWorkerDispatchError>();
    const scope = yield* Scope.make("sequential");
    yield* Scope.addFinalizer(serviceScope, Scope.close(scope, Exit.void));
    const open = openManagedWorkerSourceConnection(
      {
        sourceEnvironmentId: environmentId,
        targetEnvironmentId: request.targetEnvironmentId,
        requestId: request.requestId,
        requestDigest,
        expiresAtMs: Date.parse(request.expiresAt),
      },
      {
        resolveRegisteredTarget: Effect.succeed({
          target: profile.target,
          remotePort: input.reservation.remotePort,
          verifyRoute: () => Deferred.await(proof),
        }),
        invoke: async (operation, payload, signal) => {
          // Binding is needed to install the target harness during proof. Both
          // bind and infer still run live admission in the listener; inference
          // additionally waits for confirmed target kernel/source identity proof.
          if (operation === "infer" && !sources.get(request.requestId)?.confirmed)
            throw new Error("unconfirmed");
          return operations.value.invoke(request, operation, payload, signal);
        },
        onRoute: (route) =>
          Effect.gen(function* () {
            const typed = yield* Schema.decodeUnknownEffect(RemoteWorkerSourceRoute)(route).pipe(
              Effect.orDie,
            );
            sources.set(request.requestId, {
              digest: requestDigest,
              reservation: input.reservation,
              route: typed,
              proof,
              ready,
              profileDigest,
              scope,
              confirmed: false,
            });
            yield* Deferred.succeed(published, typed);
          }),
      },
    ).pipe(
      Effect.flatMap((connection) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(ready, undefined);
          // A live worker can spend more than the native five-minute lease in a
          // tool/build step. The owning source service renews current authority
          // while the confirmed route exists, including during desktop Quit.
          const heartbeat = yield* Effect.tryPromise({
            try: (signal) => operations.value.invoke(request, "admit", undefined, signal),
            catch: failure,
          }).pipe(
            Effect.timeout("20 seconds"),
            Effect.repeat(Schedule.spaced("60 seconds")),
            Effect.catch(() => connection.close),
            Effect.forkIn(scope),
          );
          yield* connection.disconnected.pipe(Effect.ensuring(Fiber.interrupt(heartbeat)));
        }),
      ),
      Effect.catch(() =>
        Effect.all([Deferred.fail(published, failure()), Deferred.fail(ready, failure())]),
      ),
      Effect.ensuring(Effect.sync(() => sources.delete(request.requestId))),
      Effect.provideService(Scope.Scope, scope),
      Effect.provide(runtime),
    );
    yield* open.pipe(Effect.forkIn(scope));
    const route = yield* Deferred.await(published).pipe(
      Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(failure()) }),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const remainingMs = Date.parse(request.expiresAt) - (yield* Clock.currentTimeMillis);
    yield* Effect.sleep(Math.max(1, remainingMs)).pipe(
      Effect.andThen(Scope.close(scope, Exit.void)),
      Effect.forkIn(serviceScope),
    );
    return route;
  });

  const verify = Effect.fn("WorkerConnection.verify")(function* (
    input: typeof RemoteWorkerTargetRouteInput.Type,
  ) {
    const { workerRequest: request, reservation, route } = input;
    const saved = reservations.get(request.requestId);
    if (
      request.targetEnvironmentId !== environmentId ||
      reservation.targetEnvironmentId !== environmentId ||
      reservation.requestId !== request.requestId ||
      !(yield* current(request)) ||
      !saved ||
      saved.reservation.bootstrapId !== reservation.bootstrapId ||
      reservation.requestDigest !== (yield* digest(request)) ||
      route.requestDigest !== reservation.requestDigest ||
      route.requestId !== request.requestId ||
      route.sourceEnvironmentId !== request.parent.environmentId ||
      route.targetEnvironmentId !== environmentId ||
      route.port !== saved.reservation.remotePort ||
      reservation.remotePort !== route.port
    )
      return yield* failure();
    const verifyOnce = Effect.tryPromise({
      try: async () => {
        const [tcp, tcp6] = await Promise.all([
          Fs.readFile("/proc/net/tcp", "utf8"),
          Fs.readFile("/proc/net/tcp6", "utf8"),
        ]);
        if (!verifyLinuxWorkerLoopback(route.port, tcp, tcp6)) throw new Error("not-loopback-only");
        // @effect-diagnostics-next-line globalFetch:off globalFetchInEffect:off -- Probe the real SSH-forwarded loopback socket rather than an Effect mock transport.
        const response = await fetch(`http://127.0.0.1:${route.port}/worker-source`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${route.capability}`,
            "content-type": "application/json",
          },
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- Bounded worker-only wire probe repeats the already decoded route identity.
          body: JSON.stringify({
            ...route,
            capability: undefined,
            port: undefined,
            operation: "admit",
          }),
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) throw new Error("source-not-ready");
        await response.body?.cancel();
        if (
          response.headers.get("x-workjet-source-environment") !== route.sourceEnvironmentId ||
          response.headers.get("x-workjet-target-environment") !== environmentId ||
          response.headers.get("x-workjet-worker-request") !== route.requestId ||
          response.headers.get("x-workjet-worker-digest") !== route.requestDigest
        )
          throw new Error("source-identity-mismatch");
      },
      catch: failure,
    }).pipe(Effect.retry(Schedule.spaced("100 millis").pipe(Schedule.upTo({ times: 20 }))));
    yield* verifyOnce;
    if (Option.isNone(targetHarness)) return yield* failure();
    yield* targetHarness.value.install(request, route);
    const stored = yield* Schema.encodeEffect(Schema.fromJsonString(StoredWorkerRoute))({
      requestDigest: reservation.requestDigest,
      expiresAt: request.expiresAt,
      route,
    }).pipe(Effect.mapError(failure));
    yield* secrets
      .set(secretName("route", request.requestId), new TextEncoder().encode(stored))
      .pipe(Effect.mapError(failure));
    return {
      reservation,
      sourceEnvironmentId: route.sourceEnvironmentId,
      capabilityDigest: tokenDigest(route.capability),
      loopbackOnly: true as const,
    };
  });

  const confirm = Effect.fn("WorkerConnection.confirm")(function* (input: RemoteWorkerRouteProof) {
    const saved = sources.get(input.reservation.requestId);
    if (
      !saved ||
      input.sourceEnvironmentId !== environmentId ||
      input.reservation.targetEnvironmentId !== saved.route.targetEnvironmentId ||
      input.reservation.bootstrapId !== saved.reservation.bootstrapId ||
      input.reservation.requestDigest !== saved.digest ||
      input.reservation.remotePort !== saved.route.port ||
      input.capabilityDigest !== tokenDigest(saved.route.capability) ||
      !input.loopbackOnly
    )
      return yield* failure();
    saved.confirmed = true;
    yield* Deferred.succeed(saved.proof, true);
    yield* Deferred.await(saved.ready);
  });
  const resolveTargetRoute = Effect.fn("WorkerConnection.resolveTargetRoute")(function* (
    request: RemoteWorkerRequest,
  ) {
    if (request.targetEnvironmentId !== environmentId || !(yield* current(request)))
      return yield* failure();
    const saved = yield* secrets
      .get(secretName("route", request.requestId))
      .pipe(Effect.mapError(failure));
    if (Option.isNone(saved)) return yield* failure();
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredWorkerRoute))(
      new TextDecoder().decode(saved.value),
    ).pipe(Effect.mapError(failure));
    if (value.requestDigest !== (yield* digest(request)) || value.expiresAt !== request.expiresAt)
      return yield* failure();
    const route = yield* Schema.decodeUnknownEffect(RemoteWorkerSourceRoute)(value.route).pipe(
      Effect.mapError(failure),
    );
    if (
      route.targetEnvironmentId !== environmentId ||
      route.sourceEnvironmentId !== request.parent.environmentId ||
      route.requestId !== request.requestId ||
      route.requestDigest !== value.requestDigest
    )
      return yield* failure();
    return route;
  });
  const revoke = (requestId: string) =>
    Effect.gen(function* () {
      const session = sources.get(requestId);
      if (session) yield* Scope.close(session.scope, Exit.void);
      sources.delete(requestId);
      reservations.delete(requestId);
      yield* secrets.remove(secretName("route", requestId)).pipe(Effect.ignore);
    });
  return {
    reserve: (request: RemoteWorkerRequest) => reserve(request).pipe(mutex.withPermits(1)),
    prepare: (input: typeof RemoteWorkerSourcePrepareInput.Type) =>
      prepare(input).pipe(mutex.withPermits(1)),
    verify,
    confirm,
    resolveTargetRoute,
    revoke,
  };
});
export class RemoteWorkerConnectionBootstrap extends Context.Service<
  RemoteWorkerConnectionBootstrap,
  Effect.Success<typeof make>
>()("workjet/workjet/RemoteWorkerConnectionBootstrap") {}
export const layer = Layer.effect(RemoteWorkerConnectionBootstrap, make);
