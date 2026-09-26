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

export interface CapturedWorkerWorktree {
  readonly worktreePath: string;
  readonly worktreeDev: string;
  readonly worktreeIno: string;
  readonly adminPath: string;
  readonly adminDev: string;
  readonly adminIno: string;
}

export class NativeWorkerWorktreeRemover extends Context.Service<
  NativeWorkerWorktreeRemover,
  {
    readonly capture: (
      worktreePath: string,
    ) => Effect.Effect<CapturedWorkerWorktree, NativeWorkerWorktreeRemovalError>;
    readonly removeCaptured: (
      captured: CapturedWorkerWorktree,
    ) => Effect.Effect<void, NativeWorkerWorktreeRemovalError>;
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

  const capture: NativeWorkerWorktreeRemover["Service"]["capture"] = Effect.fn(
    "NativeWorkerWorktreeRemover.capture",
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

    return {
      worktreePath,
      worktreeDev: String(worktree.dev),
      worktreeIno: String(worktreeIno),
      adminPath,
      adminDev: String(admin.dev),
      adminIno: String(adminIno),
    };
  });

  const removeCaptured: NativeWorkerWorktreeRemover["Service"]["removeCaptured"] = Effect.fn(
    "NativeWorkerWorktreeRemover.removeCaptured",
  )(function* (captured) {
    const executable = yield* binary.resolve.pipe(
      Effect.mapError(() => removalError("unavailable")),
    );
    const command = ChildProcess.make(
      executable,
      [
        "--remove-verified-worktree",
        captured.worktreePath,
        captured.worktreeDev,
        captured.worktreeIno,
        captured.adminPath,
        captured.adminDev,
        captured.adminIno,
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
        Schema.is(NativeWorkerWorktreeRemovalError)(error) ? error : removalError("failed"),
      ),
    );
    if (result.exitCode !== 0 || result.stdout.trim() !== '{"status":"removed"}') {
      return yield* removalError("failed");
    }
  });

  const remove: NativeWorkerWorktreeRemover["Service"]["remove"] = (worktreePath) =>
    capture(worktreePath).pipe(Effect.flatMap(removeCaptured));

  return NativeWorkerWorktreeRemover.of({ capture, removeCaptured, remove });
});

export const layer = Layer.effect(NativeWorkerWorktreeRemover, make());
