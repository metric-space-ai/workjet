import { assert, it } from "@effect/vitest";
import { DesktopHostTelemetryMessage, WS_METHODS } from "@workjet/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { RunBackendProcessOptions } from "./DesktopBackendManager.ts";
import {
  attachDesktopServiceTelemetry,
  DesktopServiceTelemetryError,
  type TelemetrySession,
} from "./DesktopServiceTelemetry.ts";

const encodeError = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const initialControl = {
  version: 1 as const,
  type: "setDiagnosticsDemand" as const,
  enabled: false,
};

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});
const packets: DesktopHostTelemetryMessage[] = [
  { version: 1, type: "desktopTelemetryHello", electronPid: 101 },
  {
    version: 1,
    type: "desktopTelemetry",
    electronPid: 101,
    sequence: 1,
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
  },
];
const encode = Schema.encodeSync(Schema.fromJsonString(DesktopHostTelemetryMessage));
const input: RunBackendProcessOptions = {
  executablePath: "/electron",
  entryPath: "/bin.mjs",
  cwd: "/profile",
  args: [],
  env: {},
  extendEnv: true,
  captureOutput: false,
  bootstrapDelivery: "fd3",
  preflightFailure: Option.none(),
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  bootstrap: {
    mode: "desktop",
    port: 3773,
    noBrowser: true,
    workjetHome: "/profile",
    host: "127.0.0.1",
    desktopBootstrapToken: "unused",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  desktopTelemetryStream: Stream.concat(
    Stream.fromIterable(packets.map((packet) => new TextEncoder().encode(`${encode(packet)}\n`))),
    Stream.never,
  ),
};

it.effect(
  "waits for authenticated control and snapshot acknowledgement and releases pumps with the UI scope",
  () =>
    Effect.gen(function* () {
      let released = 0;
      let controlled = false;
      const received: DesktopHostTelemetryMessage[] = [];
      let attachmentId: string | undefined;
      const session: TelemetrySession = {
        initialConfig: Effect.succeed({ environment: { runtimeInstanceId: "generation-a" } }),
        closed: Effect.never,
        client: {
          [WS_METHODS.subscribeDesktopTelemetryControl]: (binding) =>
            Stream.unwrap(
              Effect.acquireRelease(
                Effect.sync(() => {
                  assert.equal(binding.runtimeInstanceId, "generation-a");
                  attachmentId = binding.attachmentId;
                  return Stream.concat(
                    Stream.make({
                      version: 1 as const,
                      type: "setDiagnosticsDemand" as const,
                      enabled: true,
                    }),
                    Stream.never,
                  );
                }),
                () =>
                  Effect.sync(() => {
                    released++;
                  }),
              ),
            ),
          [WS_METHODS.serverPublishDesktopTelemetry]: (payload) =>
            Effect.sync(() => {
              assert.equal(controlled, true);
              assert.equal(payload.runtimeInstanceId, "generation-a");
              assert.equal(payload.attachmentId, attachmentId);
              received.push(payload.message);
            }),
        },
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* attachDesktopServiceTelemetry(session, {
            ...input,
            onDesktopTelemetryControl: () =>
              Effect.sync(() => {
                controlled = true;
              }),
          });
          assert.deepEqual(
            received.map((message) => message.type),
            ["desktopTelemetryHello", "desktopTelemetry"],
          );
          assert.equal(released, 0);
        }),
      );
      assert.equal(released, 1);
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
);

it.effect("refuses an attachment without a runtime generation before opening telemetry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const session: TelemetrySession = {
        initialConfig: Effect.succeed({ environment: {} }),
        closed: Effect.never,
        client: {
          [WS_METHODS.subscribeDesktopTelemetryControl]: () =>
            Stream.die("Missing generation must not subscribe."),
          [WS_METHODS.serverPublishDesktopTelemetry]: () =>
            Effect.die("Missing generation must not publish."),
        },
      };
      const error = yield* attachDesktopServiceTelemetry(session, input).pipe(Effect.flip);
      assert.include(error.message, "current runtime generation");
    }),
  ).pipe(Effect.provideService(Crypto.Crypto, crypto)),
);

for (const phase of [
  "control-failed",
  "control-closed",
  "publisher-failed",
  "publisher-closed",
] as const) {
  it.effect(`preserves the safe ${phase} diagnostic and releases the attachment`, () =>
    Effect.gen(function* () {
      let released = 0;
      let published = 0;
      const privateDetail = "private bearer and profile detail must not leave the transport";
      const controls =
        phase === "control-failed"
          ? Stream.fail(new DesktopServiceTelemetryError({ reason: privateDetail }))
          : phase === "control-closed"
            ? Stream.empty
            : Stream.concat(Stream.make(initialControl), Stream.never);
      const session: TelemetrySession = {
        initialConfig: Effect.succeed({ environment: { runtimeInstanceId: "generation-a" } }),
        closed: Effect.never,
        client: {
          [WS_METHODS.subscribeDesktopTelemetryControl]: () =>
            Stream.unwrap(
              Effect.acquireRelease(Effect.succeed(controls), () =>
                Effect.sync(() => {
                  released++;
                }),
              ),
            ),
          [WS_METHODS.serverPublishDesktopTelemetry]: () => {
            published++;
            return Effect.fail(new DesktopServiceTelemetryError({ reason: privateDetail }));
          },
        },
      };
      const error = yield* Effect.scoped(
        attachDesktopServiceTelemetry(session, {
          ...input,
          desktopTelemetryStream:
            phase === "publisher-closed" ? Stream.empty : input.desktopTelemetryStream,
        }),
      ).pipe(Effect.flip);
      const expected = {
        "control-failed": "Service telemetry control subscription failed.",
        "control-closed": "Service telemetry control subscription closed.",
        "publisher-failed": "Desktop telemetry publication failed.",
        "publisher-closed": "Desktop telemetry publisher closed.",
      }[phase];
      assert.equal(error.message, expected);
      assert.notInclude(encodeError(error), privateDetail);
      assert.equal(released, 1);
      assert.equal(published, phase === "publisher-failed" ? 1 : 0);
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
  );
}

for (const phase of ["control", "snapshot"] as const) {
  it.effect(`retains the acknowledgement deadline when ${phase} never arrives`, () =>
    Effect.gen(function* () {
      let released = 0;
      const received: string[] = [];
      const session: TelemetrySession = {
        initialConfig: Effect.succeed({ environment: { runtimeInstanceId: "generation-a" } }),
        closed: Effect.never,
        client: {
          [WS_METHODS.subscribeDesktopTelemetryControl]: () =>
            Stream.unwrap(
              Effect.acquireRelease(
                Effect.succeed(
                  phase === "control"
                    ? Stream.never
                    : Stream.concat(Stream.make(initialControl), Stream.never),
                ),
                () =>
                  Effect.sync(() => {
                    released++;
                  }),
              ),
            ),
          [WS_METHODS.serverPublishDesktopTelemetry]: ({ message }) => {
            received.push(message.type);
            return message.type === "desktopTelemetryHello" ? Effect.void : Effect.never;
          },
        },
      };
      const fiber = yield* Effect.forkChild(
        Effect.scoped(attachDesktopServiceTelemetry(session, input)).pipe(Effect.flip),
      );
      yield* TestClock.adjust("20 seconds");
      const error = yield* Fiber.join(fiber);
      assert.equal(error.message, "No authenticated Desktop telemetry snapshot was acknowledged.");
      assert.equal(released, 1);
      assert.deepEqual(
        received,
        phase === "control" ? [] : ["desktopTelemetryHello", "desktopTelemetry"],
      );
    }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
  );
}
