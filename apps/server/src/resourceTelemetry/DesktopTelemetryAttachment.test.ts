import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { DesktopHostTelemetrySnapshot } from "@workjet/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Receiver from "./DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import * as ResourceAttribution from "./ResourceAttribution.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";

const fixture = Layer.mergeAll(
  ServerConfig.layerTest("/fixture", { prefix: "workjet-telemetry-attachment-" }),
  ServerSettings.layerTest(),
).pipe(Layer.provide(NodeServices.layer));
const sample = (pid: number, sequence: number): DesktopHostTelemetrySnapshot => ({
  version: 1,
  type: "desktopTelemetry",
  electronPid: pid,
  sequence,
  sampledAtUnixMs: 1000,
  speedLimitPercent: Option.none(),
  electronProcesses: [],
  power: {
    source: "electron-main",
    idle: "false",
    idleSeconds: 0,
    locked: "false",
    suspended: false,
    onBattery: "false",
    lowPowerMode: "unknown",
    thermalState: "nominal",
    stale: false,
    updatedAt: DateTime.makeUnsafe(1000),
  },
});

it.effect(
  "owns one attachment, rejects stale messages, and marks its last sample stale on detach",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const receiver = yield* Receiver.make().pipe(
          Effect.provideService(ServerConfig.ServerConfig, { ...config, mode: "desktop" }),
        );
        const scopeA = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scopeA, Exit.void));
        const controls = yield* receiver.attach("connection-a").pipe(Scope.provide(scopeA));
        const initial = yield* controls.pipe(Stream.take(2), Stream.runCollect);
        assert.equal(initial.length, 2);
        assert.deepEqual(
          initial.map((message) => message.type),
          ["setDiagnosticsDemand", "setHostPowerIntervals"],
        );
        const competing = yield* receiver.attach("connection-b").pipe(Effect.flip);
        assert.equal(competing._tag, "DesktopTelemetryAttachmentError");
        yield* receiver.publish("connection-a", {
          version: 1,
          type: "desktopTelemetryHello",
          electronPid: 41,
        });
        yield* receiver.publish("connection-a", sample(41, 7));
        assert.equal((yield* receiver.health).status, "healthy");
        yield* receiver.publish("connection-a", sample(41, 7));
        yield* receiver.publish("connection-a", sample(41, 6));
        assert.equal(Option.getOrThrow(yield* receiver.latest).sequence, 7);
        const wrongPid = yield* receiver.publish("connection-a", sample(42, 8)).pipe(Effect.flip);
        assert.equal(wrongPid._tag, "DesktopTelemetryAttachmentError");
        yield* Scope.close(scopeA, Exit.void);
        assert.equal((yield* receiver.health).status, "stopped");
        assert.equal(Option.getOrThrow(yield* receiver.latest).power.stale, true);
        yield* receiver.attach("connection-b");
        assert.equal((yield* receiver.health).status, "starting");
        const stale = yield* receiver.publish("connection-a", sample(41, 8)).pipe(Effect.flip);
        assert.equal(stale._tag, "DesktopTelemetryAttachmentError");
        yield* receiver.publish("connection-b", {
          version: 1,
          type: "desktopTelemetryHello",
          electronPid: 42,
        });
        yield* receiver.publish("connection-b", sample(42, 1));
        assert.equal(Option.getOrThrow(yield* receiver.latest).electronPid, 42);
      }),
    ).pipe(Effect.provide(fixture)),
);

it.effect(
  "replays current demand and intervals even after control updates while disconnected",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const receiver = yield* Receiver.make().pipe(
          Effect.provideService(ServerConfig.ServerConfig, { ...config, mode: "desktop" }),
        );
        yield* receiver.setDiagnosticsDemand(true);
        const controls = yield* receiver.attach("reopened-desktop");
        const messages = yield* controls.pipe(Stream.take(2), Stream.runCollect);
        assert.deepEqual(messages[0], { version: 1, type: "setDiagnosticsDemand", enabled: true });
        assert.equal(messages[1]?.type, "setHostPowerIntervals");
      }),
    ).pipe(Effect.provide(fixture)),
);

it.effect(
  "clears native process monitoring on detach and registers only the reattached process identity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const receiver = yield* Receiver.make().pipe(
          Effect.provideService(ServerConfig.ServerConfig, { ...config, mode: "desktop" }),
        );
        const registrations =
          yield* Queue.unbounded<
            ReadonlyArray<{ readonly pid: number; readonly startTimeMs?: number }>
          >();
        yield* ResourceTelemetry.make().pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(Receiver.DesktopTelemetryReceiver, receiver),
              NativeTelemetryClient.layerTest({
                setExternalProcesses: (processes) =>
                  Queue.offer(registrations, processes).pipe(Effect.asVoid),
              }),
              ResourceAttribution.layer,
            ),
          ),
        );
        const publish = (connection: string, pid: number, creationTimeMs: number) =>
          Effect.gen(function* () {
            yield* receiver.publish(connection, {
              version: 1,
              type: "desktopTelemetryHello",
              electronPid: pid,
            });
            yield* receiver.publish(connection, {
              ...sample(pid, 1),
              electronProcesses: [
                {
                  pid,
                  creationTimeMs,
                  type: "Browser",
                  name: "electron",
                  cpuPercent: 2,
                  cumulativeCpuSeconds: 0.02,
                  idleWakeupsPerSecond: 3,
                  workingSetBytes: 4096,
                  peakWorkingSetBytes: 8192,
                },
              ],
            });
          });
        const scopeA = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scopeA, Exit.void));
        yield* receiver.attach("desktop-a").pipe(Scope.provide(scopeA));
        yield* publish("desktop-a", 41, 300);
        assert.deepEqual(yield* Queue.take(registrations), [{ pid: 41, startTimeMs: 300 }]);
        yield* Scope.close(scopeA, Exit.void);
        assert.deepEqual(yield* Queue.take(registrations), []);
        yield* receiver.attach("desktop-b");
        yield* publish("desktop-b", 42, 400);
        assert.deepEqual(yield* Queue.take(registrations), [{ pid: 42, startTimeMs: 400 }]);
      }),
    ).pipe(Effect.provide(fixture)),
);

it.effect("rejects RPC telemetry for a non-desktop server", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const receiver = yield* Receiver.make();
      const error = yield* receiver.attach("remote").pipe(Effect.flip);
      assert.equal(error._tag, "DesktopTelemetryAttachmentError");
    }),
  ).pipe(Effect.provide(fixture)),
);
