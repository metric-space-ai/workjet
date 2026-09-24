// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ResourceMonitorBinary } from "../resourceTelemetry/ResourceMonitorBinary.ts";

export class NativeWorkerWorktreeRemovalError extends Schema.TaggedErrorClass<NativeWorkerWorktreeRemovalError>()(
  "NativeWorkerWorktreeRemovalError",
  { reason: Schema.Literals(["identity", "backlink", "unavailable", "failed", "timeout"]) },
) {}

export class NativeWorkerWorktreeRemover extends Context.Service<
  NativeWorkerWorktreeRemover,
  {
    readonly remove: (
      worktreePath: string,
    ) => Effect.Effect<void, NativeWorkerWorktreeRemovalError>;
  }
>()("workjet/workjet/NativeWorkerWorktreeRemover") {}

const removalError = (reason: NativeWorkerWorktreeRemovalError["reason"]) =>
  new NativeWorkerWorktreeRemovalError({ reason });

const boundedOutput = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (value, chunk) => (value.length > 128 ? value : (value + chunk).slice(0, 129)),
    ),
  );

export const make = Effect.fn("NativeWorkerWorktreeRemover.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const binary = yield* ResourceMonitorBinary;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const remove: NativeWorkerWorktreeRemover["Service"]["remove"] = Effect.fn(
    "NativeWorkerWorktreeRemover.remove",
  )(function* (worktreePath) {
    const backlink = yield* fs
      .readFileString(path.join(worktreePath, ".git"))
      .pipe(Effect.mapError(() => removalError("backlink")));
    const normalizedBacklink = backlink.trimEnd();
    if (!normalizedBacklink.startsWith("gitdir: ")) {
      return yield* removalError("backlink");
    }
    const adminPath = normalizedBacklink.slice("gitdir: ".length);
    if (
      !path.isAbsolute(adminPath) ||
      path.resolve(adminPath) !== adminPath ||
      path.basename(path.dirname(adminPath)) !== "worktrees"
    ) {
      return yield* removalError("backlink");
    }

    const [worktree, admin] = yield* Effect.all([fs.stat(worktreePath), fs.stat(adminPath)]).pipe(
      Effect.mapError(() => removalError("identity")),
    );
    const worktreeIno = Option.getOrUndefined(worktree.ino);
    const adminIno = Option.getOrUndefined(admin.ino);
    if (worktreeIno === undefined || adminIno === undefined) {
      return yield* removalError("identity");
    }

    const executable = yield* binary.resolve.pipe(
      Effect.mapError(() => removalError("unavailable")),
    );
    const command = ChildProcess.make(
      executable,
      [
        "--remove-verified-worktree",
        worktreePath,
        String(worktree.dev),
        String(worktreeIno),
        adminPath,
        String(admin.dev),
        String(adminIno),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(2),
      },
    );
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(command);
        const [stdout, , exitCode] = yield* Effect.all(
          [boundedOutput(child.stdout), boundedOutput(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        return { stdout, exitCode: Number(exitCode) };
      }),
    ).pipe(
      Effect.timeout(Duration.minutes(2)),
      Effect.catchTag("TimeoutError", () => Effect.fail(removalError("timeout"))),
      Effect.mapError((error) =>
        error instanceof NativeWorkerWorktreeRemovalError ? error : removalError("failed"),
      ),
    );
    if (result.exitCode !== 0 || result.stdout.trim() !== '{"status":"removed"}') {
      return yield* removalError("failed");
    }
  });

  return NativeWorkerWorktreeRemover.of({ remove });
});

export const layer = Layer.effect(NativeWorkerWorktreeRemover, make());
