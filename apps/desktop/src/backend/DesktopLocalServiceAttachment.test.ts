import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  makeAttachment,
  discoverService,
  LocalServiceAttachmentError,
} from "./DesktopLocalServiceAttachment.ts";
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
        install: () => Effect.die("An existing service must not be installed again."),
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
              return {
                closed: Effect.fail(new LocalServiceAttachmentError({ reason: "socket closed" })),
              };
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
      install: () => Effect.die("An existing service must not be installed again."),
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
          install: () => Effect.die("An existing service must not be installed again."),
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
      install: () => Effect.die("An existing service must not be installed again."),
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

const makeDiscoveryHarness = Effect.fn("test.desktopServiceDiscovery")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-desktop-discovery-" });
  const baseDir = path.join(root, "profile");
  const resourcesPath = path.join(root, "resources");
  const archive = path.join(resourcesPath, "ssh-servers", "workjet-server-darwin-arm64.tgz");
  yield* fs.makeDirectory(path.dirname(archive), { recursive: true });
  yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
  yield* fs.writeFileString(archive, "archive fixture; backend validates its contents");
  yield* fs.writeFileString(
    `${archive}.sha256`,
    `${"a".repeat(64)}  workjet-server-darwin-arm64.tgz\n`,
  );
  const environment = {
    isDevelopment: false,
    isPackaged: true,
    platform: "darwin",
    processArch: "arm64",
    baseDir,
    resourcesPath,
    configuredBackendPort: Option.none<number>(),
    path,
  };
  const statusCalls: ReadonlyArray<string>[] = [];
  const discover = () =>
    discoverService({
      environment,
      fs,
      status: (args) =>
        Effect.sync(() => {
          statusCalls.push(args);
          return { supported: true, installed: false, current: false };
        }),
    });
  return { discover, environment, fs, path, archive, baseDir, statusCalls };
});

it.layer(NodeServices.layer)("packaged service discovery and first installation", (it) => {
  it.effect(
    "discovers a fresh packaged profile, installs the selected endpoint once and reattaches",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeDiscoveryHarness();
        const discovered = yield* fixture.discover();
        assert.equal(discovered.selection, "install");
        assert.deepEqual(discovered.artifactArgs, [
          "--bundle-archive",
          fixture.archive,
          "--bundle-sha256",
          "a".repeat(64),
        ]);
        const actions: string[] = [];
        let ready = 0;
        const attachment = yield* makeAttachment({
          discover: Effect.succeed(discovered.selection),
          install: (selected) =>
            Effect.sync(() => {
              assert.deepEqual(selected, endpoint);
              actions.push("install");
            }),
          assertCurrent: Effect.sync(() => {
            actions.push("verify");
          }),
          start: Effect.die("Install already starts the service; do not request another start."),
          connect: () =>
            Effect.sync(() => {
              actions.push("connect");
              return { closed: Effect.fail(new Error("connection closed")) };
            }),
        });
        assert.deepEqual(yield* attachment.resolvePort, Option.none());
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
        assert.deepEqual(actions, ["install", "verify", "connect", "verify", "connect"]);
        assert.equal(ready, 2);
        assert.deepEqual(fixture.statusCalls, [[]]);
      }).pipe(Effect.provide(noForeground)),
  );

  it.effect("never retries an uncertain first install or falls back to a foreground owner", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDiscoveryHarness();
      const discovered = yield* fixture.discover();
      let installs = 0;
      const attachment = yield* makeAttachment({
        discover: Effect.succeed(discovered.selection),
        install: () =>
          Effect.suspend(() => {
            installs++;
            return Effect.fail(
              new LocalServiceAttachmentError({ reason: "installation reply lost" }),
            );
          }),
        assertCurrent: Effect.die("Uncertain installation must not report current."),
        start: Effect.die("Uncertain installation must not start again."),
        connect: () => Effect.die("Uncertain installation must not attach."),
      });
      yield* attachment.resolvePort;
      for (let index = 0; index < 2; index++) {
        const exit = yield* Effect.scoped(
          attachment.run({
            ...input,
            onReady: () => Effect.die("Uncertain installation cannot become ready."),
          }),
        );
        assert.equal(exit.restart, false);
      }
      assert.equal(installs, 1);
    }).pipe(Effect.provide(noForeground)),
  );

  it.effect("rejects an invalid selected endpoint before first installation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDiscoveryHarness();
      const discovered = yield* fixture.discover();
      const attachment = yield* makeAttachment({
        discover: Effect.succeed(discovered.selection),
        install: () => Effect.die("Invalid endpoint must not be installed."),
        assertCurrent: Effect.die("Invalid endpoint must not be inspected."),
        start: Effect.die("Invalid endpoint must not start."),
        connect: () => Effect.die("Invalid endpoint must not connect."),
      });
      yield* attachment.resolvePort;
      const exit = yield* Effect.scoped(
        attachment.run({
          ...input,
          bootstrap: { ...input.bootstrap, port: 0 },
        }),
      );
      assert.equal(exit.restart, false);
    }).pipe(Effect.provide(noForeground)),
  );

  for (const retained of [
    "state.sqlite",
    "state.sqlite-wal",
    "dangling",
    "service-state",
  ] as const) {
    it.effect(`does not classify retained ${retained} as a fresh packaged profile`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeDiscoveryHarness();
        const { fs, path, baseDir } = fixture;
        if (retained === "service-state") {
          yield* fs.makeDirectory(path.join(baseDir, "runtime"), { recursive: true });
          yield* fs.writeFileString(path.join(baseDir, "runtime", "service-state.json"), "{}");
        } else if (retained === "dangling") {
          yield* fs.symlink(
            path.join(baseDir, "missing.sqlite"),
            path.join(baseDir, "userdata", "state.sqlite"),
          );
        } else {
          yield* fs.writeFileString(path.join(baseDir, "userdata", retained), "retained");
        }
        const error = yield* fixture.discover().pipe(Effect.flip);
        assert.equal(error._tag, "LocalServiceAttachmentError");
        assert.include(
          error.message,
          retained === "service-state" ? "state exists" : "explicit migration",
        );
      }),
    );
  }

  it.effect("refuses an invalid shipped checksum before selecting installation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDiscoveryHarness();
      yield* fixture.fs.writeFileString(
        `${fixture.archive}.sha256`,
        `${"a".repeat(64)}  other-file.tgz\n`,
      );
      const error = yield* fixture.discover().pipe(Effect.flip);
      assert.include(error.message, "archive or checksum");
    }),
  );
});
