import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  type RemoteWorkerRouteReservation,
  type RemoteWorkerSourceRoute,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SshConnectionTarget } from "./model.ts";
import { SshConnectionProfile } from "./catalog.ts";
import {
  bootstrapWorkerSource,
  registeredWorkerSshProfile,
  RemoteWorkerRelayUnavailable,
} from "./remoteWorkers.ts";

const targetId = EnvironmentId.make("gpu3");
const profile = new SshConnectionProfile({
  connectionId: "saved-gpu3",
  environmentId: targetId,
  label: "gpu3",
  target: { alias: "gpu3", hostname: "gpu3.example", username: "worker", port: 22 },
});
const reservation: RemoteWorkerRouteReservation = {
  bootstrapId: "b".repeat(64),
  requestId: ThreadId.make("worker"),
  requestDigest: "a".repeat(64),
  targetEnvironmentId: targetId,
  remotePort: 40000,
};
const route: RemoteWorkerSourceRoute = {
  sourceEnvironmentId: EnvironmentId.make("source"),
  targetEnvironmentId: targetId,
  requestId: reservation.requestId,
  requestDigest: reservation.requestDigest,
  capability: "a".repeat(43),
  port: reservation.remotePort,
};

it.effect(
  "uses the registered SSH profile only when its connection and environment pins match",
  () =>
    Effect.gen(function* () {
      const target = new SshConnectionTarget({
        environmentId: targetId,
        connectionId: "saved-gpu3",
        label: "gpu3",
      });
      const actual = yield* registeredWorkerSshProfile(
        { target, profile: Option.some(profile) },
        targetId,
      );
      assert.deepEqual(actual, {
        connectionId: profile.connectionId,
        environmentId: targetId,
        target: profile.target,
      });
      yield* Effect.flip(registeredWorkerSshProfile(undefined, targetId));
      yield* Effect.flip(registeredWorkerSshProfile({ target, profile: Option.none() }, targetId));
      yield* Effect.flip(
        registeredWorkerSshProfile(
          { target, profile: Option.some(profile) },
          EnvironmentId.make("foreign"),
        ),
      );
      yield* Effect.flip(
        registeredWorkerSshProfile(
          {
            target: new SshConnectionTarget({ ...target, connectionId: "other" }),
            profile: Option.some(profile),
          },
          targetId,
        ),
      );
    }),
);

it.effect(
  "confirms target proof before allowing delivery and retries the identical reservation after lost acknowledgement",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let loseConfirmation = true;
      const port = {
        reserve: Effect.sync(() => {
          calls.push("reserve");
          return reservation;
        }),
        prepare: (input: RemoteWorkerRouteReservation) =>
          Effect.sync(() => {
            assert.deepEqual(input, reservation);
            calls.push("prepare");
            return route;
          }),
        verify: (input: RemoteWorkerRouteReservation, value: RemoteWorkerSourceRoute) =>
          Effect.sync(() => {
            assert.deepEqual(input, reservation);
            assert.deepEqual(value, route);
            calls.push("verify");
            return {
              reservation,
              sourceEnvironmentId: route.sourceEnvironmentId,
              capabilityDigest: "c".repeat(64),
              loopbackOnly: true as const,
            };
          }),
        confirm: () =>
          Effect.suspend(() => {
            calls.push("confirm");
            if (loseConfirmation) {
              loseConfirmation = false;
              return Effect.fail(new RemoteWorkerRelayUnavailable({}));
            }
            return Effect.void;
          }),
      };
      yield* Effect.flip(bootstrapWorkerSource(port));
      assert.deepEqual(calls, ["reserve", "prepare", "verify", "confirm"]);
      yield* bootstrapWorkerSource(port);
      assert.deepEqual(calls, [
        "reserve",
        "prepare",
        "verify",
        "confirm",
        "reserve",
        "prepare",
        "verify",
        "confirm",
      ]);
    }),
);

it.effect("never confirms or reaches receiver delivery after failed target proof", () =>
  Effect.gen(function* () {
    let confirmed = false;
    yield* Effect.flip(
      bootstrapWorkerSource({
        reserve: Effect.succeed(reservation),
        prepare: () => Effect.succeed(route),
        verify: () => Effect.fail(new RemoteWorkerRelayUnavailable({})),
        confirm: () =>
          Effect.sync(() => {
            confirmed = true;
          }),
      }),
    );
    assert.equal(confirmed, false);
  }),
);
