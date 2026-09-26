import { assert, it } from "@effect/vitest";
import { DesktopHostTelemetryMessage, WS_METHODS } from "@workjet/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { RunBackendProcessOptions } from "./DesktopBackendManager.ts";
import { attachDesktopServiceTelemetry, type TelemetrySession } from "./DesktopServiceTelemetry.ts";

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
