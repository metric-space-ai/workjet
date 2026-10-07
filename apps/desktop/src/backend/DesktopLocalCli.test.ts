import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { runLocalCli } from "./DesktopLocalServiceSession.ts";

const serializeError = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.fn("test.localCli.fixture")(function* (body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-local-cli-" });
  const entryPath = path.join(cwd, "fixture.mjs");
  yield* fs.writeFileString(entryPath, body);
  return {
    executablePath: process.execPath,
    entryPath,
    cwd,
    env: { FIXTURE_VALUE: "bounded" },
    extendEnv: false,
  };
});

it.live("captures successful CLI output and passes arguments without a shell", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* fixture(
        'process.stdout.write(process.env.FIXTURE_VALUE + ":" + process.argv[2] + ":ä");',
      );
      assert.equal(
        yield* runLocalCli(config, ["literal;not-a-shell"]),
        "bounded:literal;not-a-shell:ä",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

for (const [name, body] of [
  [
    "nonzero exit",
    'process.stdout.write("fixture-secret"); process.stderr.write("fixture-secret"); process.exitCode = 7;',
  ],
  ["oversized stdout", 'process.stdout.write("x".repeat(65537));'],
  ["oversized stderr", 'process.stderr.write("x".repeat(65537));'],
] as const) {
  it.live(`rejects CLI ${name} without exposing captured output`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* fixture(body);
        const error = yield* runLocalCli(config, []).pipe(Effect.flip);
        assert.equal(error._tag, "LocalServiceSessionError");
        assert.notInclude(error.message, "fixture-secret");
        assert.notInclude(error.message, "xxxx");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect("enforces the deadline even while enrollment masks caller interruption", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* fixture("setInterval(() => {}, 1000);");
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const started = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const observed = {
        ...spawner,
        spawn: (command: Parameters<typeof spawner.spawn>[0]) =>
          spawner.spawn(command).pipe(Effect.tap((child) => Deferred.succeed(started, child))),
      };
      const fiber = yield* runLocalCli(config, []).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
        Effect.uninterruptible,
        Effect.forkScoped,
      );
      const child = yield* Deferred.await(started);
      yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore));
      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.equal(error._tag, "LocalServiceSessionError");
      assert.deepEqual(error.commandFailure, { command: "authorization", kind: "timeout" });
      assert.isFalse(yield* child.isRunning);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps a service installation alive past the short CLI deadline and still reaps it at five minutes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* fixture("setInterval(() => {}, 1000);");
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const started = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
        const observed = {
          ...spawner,
          spawn: (command: Parameters<typeof spawner.spawn>[0]) =>
            spawner.spawn(command).pipe(Effect.tap((child) => Deferred.succeed(started, child))),
        };
        const fiber = yield* runLocalCli(config, ["service", "install"], "5 minutes").pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
          Effect.forkScoped,
        );
        const child = yield* Deferred.await(started);
        yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore));
        yield* TestClock.adjust("30 seconds");
        assert.isTrue(yield* child.isRunning);
        yield* TestClock.adjust("270 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);
        assert.equal(error._tag, "LocalServiceSessionError");
        assert.deepEqual(error.commandFailure, { command: "service-install", kind: "timeout" });
        assert.isFalse(yield* child.isRunning);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("terminates and reaps its scoped CLI child when the caller is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* fixture("setInterval(() => {}, 1000);");
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const started = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const observed = {
        ...spawner,
        spawn: (command: Parameters<typeof spawner.spawn>[0]) =>
          spawner.spawn(command).pipe(Effect.tap((child) => Deferred.succeed(started, child))),
      };
      const fiber = yield* runLocalCli(config, []).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
        Effect.forkScoped,
      );
      const child = yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      assert.isFalse(yield* child.isRunning);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

for (const [name, args, body, expected] of [
  [
    "bundle staging failure",
    ["service", "install", "synthetic-private-argument"],
    'console.error("staging the bundled runtime: token=synthetic-secret"); process.exit(17);',
    { command: "service-install", kind: "exit", exitCode: 17, step: "bundle-staging" },
  ],
  [
    "bundle staging failure on stdout",
    ["service", "install", "synthetic-private-argument"],
    'console.log("staging the bundled runtime: token=synthetic-secret"); process.exit(17);',
    { command: "service-install", kind: "exit", exitCode: 17, step: "bundle-staging" },
  ],
  [
    "runtime verification failure on stdout",
    ["service", "install"],
    'console.log("verifying the pinned workjet runtime: token=synthetic-secret"); process.exit(18);',
    { command: "service-install", kind: "exit", exitCode: 18, step: "runtime-verification" },
  ],
  [
    "service start failure on stdout",
    ["service", "install"],
    'console.log("starting the LaunchAgent: token=synthetic-secret"); process.exit(19);',
    { command: "service-install", kind: "exit", exitCode: 19, step: "service-start" },
  ],
  [
    "authorization failure",
    ["auth", "session", "synthetic-private-argument"],
    'console.error("staging the bundled runtime: token=synthetic-secret"); process.exit(4);',
    { command: "authorization", kind: "exit", exitCode: 4 },
  ],
  [
    "local service discovery failure",
    ["__desktop-target", "--base-dir", "synthetic-private-argument"],
    'console.error("token=synthetic-secret"); process.exit(23);',
    { command: "service-discovery", kind: "exit", exitCode: 23 },
  ],
  [
    "oversized install diagnostics",
    ["service", "install"],
    'process.stderr.write(Buffer.alloc(70 * 1024, "x"));',
    { command: "service-install", kind: "output-limit" },
  ],
] as const) {
  it.live(`retains safe metadata for ${name} without retaining secrets or paths`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* fixture(body);
        const error = yield* runLocalCli(config, args).pipe(Effect.flip);
        assert.deepEqual(error.commandFailure, expected);
        assert.notInclude(serializeError(error), "synthetic-secret");
        assert.notInclude(serializeError(error), "synthetic-private-argument");
        assert.notInclude(serializeError(error), config.cwd);
        assert.isBelow(serializeError(error).length, 1000);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.live("distinguishes a missing CLI executable from an install exit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* fixture("");
      const path = yield* Path.Path;
      const error = yield* runLocalCli(
        { ...config, executablePath: path.join(config.cwd, "missing-node") },
        ["service", "start"],
      ).pipe(Effect.flip);
      assert.deepEqual(error.commandFailure, { command: "service-start", kind: "spawn" });
      assert.notInclude(serializeError(error), config.cwd);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
