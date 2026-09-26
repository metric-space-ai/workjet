import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { makeAttachment, LocalServiceAttachmentError } from "./DesktopLocalServiceAttachment.ts";
import type { RunBackendProcessOptions } from "./DesktopBackendManager.ts";
vi.mock("electron", () => ({ safeStorage: {} }));

const endpoint = {
  port: 3888,
  host: "127.0.0.1" as const,
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};
const input: RunBackendProcessOptions = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  args: [],
  env: {},
  extendEnv: true,
  bootstrapDelivery: "fd3",
  captureOutput: true,
  preflightFailure: Option.none(),
  httpBaseUrl: new URL("http://127.0.0.1:3888"),
  localSession: { baseDir: "/profile", serverVersion: "1.2.3" },
  bootstrap: {
    mode: "desktop",
    port: endpoint.port,
    host: endpoint.host,
    noBrowser: true,
    workjetHome: "/profile",
    desktopBootstrapToken: "unused",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  desktopTelemetryStream: Stream.empty,
};
const noForeground = Layer.mergeAll(
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("Must not spawn a foreground backend.")),
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("A fake attachment must not contact a server.")),
  ),
);

it.effect(
  "reuses the saved port, reconnects without another start, and releases only attachments",
  () =>
    Effect.gen(function* () {
      let discoveries = 0;
      let starts = 0;
      let connects = 0;
      let releases = 0;
      let ready = 0;
      const attachment = yield* makeAttachment({
        discover: Effect.sync(() => {
          discoveries++;
          return Option.some(endpoint);
        }),
        assertCurrent: Effect.void,
        start: Effect.sync(() => {
          starts++;
        }),
        connect: () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              connects++;
              return { closed: Effect.fail(new Error("socket closed")) };
            }),
            () =>
              Effect.sync(() => {
                releases++;
              }),
          ),
      });
      assert.deepEqual(yield* attachment.resolvePort, Option.some(3888));
      assert.deepEqual(yield* attachment.resolvePort, Option.some(3888));
      for (let index = 0; index < 2; index++) {
        const exit = yield* Effect.scoped(
          attachment.run({
            ...input,
            onReady: () =>
              Effect.sync(() => {
                ready++;
              }),
          }),
        );
        assert.notEqual(exit.restart, false);
      }
      assert.equal(discoveries, 1);
      assert.equal(starts, 1);
      assert.equal(connects, 2);
      assert.equal(releases, 2);
      assert.equal(ready, 2);
    }).pipe(Effect.provide(noForeground)),
);

it.effect("closing the UI attachment scope does not request any service control", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    let starts = 0;
    let releases = 0;
    const attachment = yield* makeAttachment({
      discover: Effect.succeed(Option.some(endpoint)),
      assertCurrent: Effect.void,
      start: Effect.sync(() => {
        starts++;
      }),
      connect: () =>
        Effect.acquireRelease(Effect.succeed({ closed: Effect.never }), () =>
          Effect.sync(() => {
            releases++;
          }),
        ),
    });
    yield* attachment.resolvePort;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          attachment.run({
            ...input,
            onReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
          }),
        );
        yield* Deferred.await(ready);
        yield* Fiber.interrupt(fiber);
      }),
    );
    assert.equal(starts, 1);
    assert.equal(releases, 1);
  }).pipe(Effect.provide(noForeground)),
);

it.effect(
  "blocks an uncertain start or authentication failure without foreground fallback or readiness",
  () =>
    Effect.gen(function* () {
      for (const phase of ["start", "authenticate"] as const) {
        let starts = 0;
        let connects = 0;
        let ready = 0;
        const error = new LocalServiceAttachmentError({ reason: phase });
        const attachment = yield* makeAttachment({
          discover: Effect.succeed(Option.some(endpoint)),
          assertCurrent: Effect.void,
          start: Effect.suspend(() => {
            starts++;
            return phase === "start" ? Effect.fail(error) : Effect.void;
          }),
          connect: () =>
            Effect.suspend(() => {
              connects++;
              return Effect.fail(error);
            }),
        });
        yield* attachment.resolvePort;
        const result = yield* Effect.scoped(
          attachment.run({
            ...input,
            onReady: () =>
              Effect.sync(() => {
                ready++;
              }),
          }),
        );
        assert.equal(result.restart, false);
        assert.equal(starts, 1);
        assert.equal(connects, phase === "start" ? 0 : 1);
        assert.equal(ready, 0);
      }
    }).pipe(Effect.provide(noForeground)),
);

it.effect("refuses changed endpoint settings before starting or attaching", () =>
  Effect.gen(function* () {
    const attachment = yield* makeAttachment({
      discover: Effect.succeed(Option.some(endpoint)),
      assertCurrent: Effect.die("Endpoint mismatch must fail before service inspection."),
      start: Effect.die("Endpoint mismatch must not start the service."),
      connect: () => Effect.die("Endpoint mismatch must not attach."),
    });
    yield* attachment.resolvePort;
    const result = yield* Effect.scoped(
      attachment.run({ ...input, bootstrap: { ...input.bootstrap, port: 3999 } }),
    );
    assert.equal(result.restart, false);
    assert.include(result.reason, "settings do not match");
  }).pipe(Effect.provide(noForeground)),
);
