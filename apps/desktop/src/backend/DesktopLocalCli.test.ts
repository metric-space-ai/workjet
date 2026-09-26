import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { runLocalCli } from "./DesktopLocalServiceSession.ts";

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
