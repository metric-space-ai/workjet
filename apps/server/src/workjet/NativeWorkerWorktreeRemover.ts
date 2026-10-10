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
  {
    reason: Schema.Literals(["identity", "backlink", "unavailable", "failed", "timeout"]),
    recoveryWorktreePath: Schema.optional(Schema.String),
    recoveryAdminPath: Schema.optional(Schema.String),
    originalWorktreePath: Schema.optional(Schema.String),
    originalAdminPath: Schema.optional(Schema.String),
    recoveryLocationStatus: Schema.optional(Schema.Literals(["candidate", "verified"])),
  },
) {}

export interface CapturedWorkerWorktree {
  readonly kind?: "isolated";
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
      kind?: "isolated",
    ) => Effect.Effect<CapturedWorkerWorktree, NativeWorkerWorktreeRemovalError>;
    readonly publishCaptured: (
      captured: CapturedWorkerWorktree,
      destination: string,
    ) => Effect.Effect<CapturedWorkerWorktree, NativeWorkerWorktreeRemovalError>;
    readonly quarantineCaptured: (
      captured: CapturedWorkerWorktree,
      reference: { readonly headOid: string; readonly branchRef: string },
    ) => Effect.Effect<
      {
        readonly recoveryWorktreePath: string;
        readonly recoveryAdminPath: string;
        readonly originalWorktreePath: string;
        readonly originalAdminPath: string;
        readonly recoveryLocationStatus: "verified";
      },
      NativeWorkerWorktreeRemovalError
    >;
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
  )(function* (worktreePath, kind) {
    let adminPath: string;
    if (kind === "isolated") {
      adminPath = path.join(worktreePath, ".git");
      const [realWorktree, realAdmin] = yield* Effect.all([
        fs.realPath(worktreePath),
        fs.realPath(adminPath),
      ]).pipe(Effect.mapError(() => removalError("identity")));
      if (realWorktree !== worktreePath || realAdmin !== adminPath)
        return yield* removalError("identity");
    } else {
      // The default capture never treats a standalone/manual repository as an
      // automatically removable worker checkout.
      const backlink = yield* fs
        .readFileString(path.join(worktreePath, ".git"))
        .pipe(Effect.mapError(() => removalError("backlink")));
      const normalizedBacklink = backlink.trimEnd();
      if (!normalizedBacklink.startsWith("gitdir: ")) return yield* removalError("backlink");
      adminPath = normalizedBacklink.slice("gitdir: ".length);
      if (
        !path.isAbsolute(adminPath) ||
        path.resolve(adminPath) !== adminPath ||
        path.basename(path.dirname(adminPath)) !== "worktrees"
      )
        return yield* removalError("backlink");
    }

    const [worktree, admin] = yield* Effect.all([fs.stat(worktreePath), fs.stat(adminPath)]).pipe(
      Effect.mapError(() => removalError("identity")),
    );
    const worktreeIno = Option.getOrUndefined(worktree.ino);
    const adminIno = Option.getOrUndefined(admin.ino);
    if (
      worktreeIno === undefined ||
      adminIno === undefined ||
      worktree.type !== "Directory" ||
      admin.type !== "Directory"
    ) {
      return yield* removalError("identity");
    }

    return {
      ...(kind === "isolated" ? { kind } : {}),
      worktreePath,
      worktreeDev: String(worktree.dev),
      worktreeIno: String(worktreeIno),
      adminPath,
      adminDev: String(admin.dev),
      adminIno: String(adminIno),
    };
  });

  const runCaptured = Effect.fn("NativeWorkerWorktreeRemover.runCaptured")(function* (
    captured: CapturedWorkerWorktree,
    mode: "remove" | "quarantine" | "publish",
    referenceArgs: ReadonlyArray<string> = [],
  ) {
    const executable = yield* binary.resolve.pipe(
      Effect.mapError(() => removalError("unavailable")),
    );
    const command = ChildProcess.make(
      executable,
      [
        mode === "publish"
          ? "--publish-isolated-worktree"
          : mode === "remove"
            ? "--remove-verified-worktree"
            : captured.kind === "isolated"
              ? "--quarantine-isolated-worktree"
              : "--quarantine-rejected-worktree",
        captured.worktreePath,
        captured.worktreeDev,
        captured.worktreeIno,
        captured.adminPath,
        captured.adminDev,
        captured.adminIno,
        ...referenceArgs,
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
    const expected =
      mode === "publish"
        ? '{"status":"published"}'
        : mode === "remove"
          ? '{"status":"removed"}'
          : '{"status":"quarantined"}';
    if (result.exitCode !== 0 || result.stdout.trim() !== expected) {
      return yield* removalError("failed");
    }
  });

  const removeCaptured: NativeWorkerWorktreeRemover["Service"]["removeCaptured"] = (captured) =>
    captured.kind === "isolated"
      ? Effect.fail(removalError("backlink"))
      : runCaptured(captured, "remove");
  const publishCaptured: NativeWorkerWorktreeRemover["Service"]["publishCaptured"] = Effect.fn(
    "NativeWorkerWorktreeRemover.publishCaptured",
  )(function* (captured, destination) {
    if (
      captured.kind !== "isolated" ||
      captured.adminPath !== path.join(captured.worktreePath, ".git") ||
      path.dirname(captured.worktreePath) !== path.dirname(destination)
    )
      return yield* removalError("identity");
    yield* runCaptured(captured, "publish", [destination]);
      const observed = yield* capture(destination, "isolated");
      if (
        observed.worktreeDev !== captured.worktreeDev ||
        observed.worktreeIno !== captured.worktreeIno ||
        observed.adminDev !== captured.adminDev ||
        observed.adminIno !== captured.adminIno
      ) return yield* removalError("identity");
    // Preserve the persisted identities after an atomic move. A fresh
    // observation must match them and cannot adopt a replacement.
    return { ...captured, worktreePath: destination, adminPath: path.join(destination, ".git") };
  });
  const quarantineCaptured: NativeWorkerWorktreeRemover["Service"]["quarantineCaptured"] =
    Effect.fn("NativeWorkerWorktreeRemover.quarantineCaptured")(function* (captured, reference) {
      const recovery = {
        originalWorktreePath: captured.worktreePath,
        originalAdminPath: captured.adminPath,
        recoveryLocationStatus: "candidate" as const,
        recoveryWorktreePath: `${captured.worktreePath}.workjet-rejected-${captured.worktreeIno}`,
        recoveryAdminPath:
          captured.kind === "isolated"
            ? path.join(`${captured.worktreePath}.workjet-rejected-${captured.worktreeIno}`, ".git")
            : path.join(
                path.dirname(path.dirname(captured.adminPath)),
                "workjet-rejected",
                `${path.basename(captured.adminPath)}-${captured.adminIno}`,
              ),
      };
      yield* runCaptured(captured, "quarantine", [reference.headOid, reference.branchRef]).pipe(
        Effect.mapError(
          (error) => new NativeWorkerWorktreeRemovalError({ reason: error.reason, ...recovery }),
        ),
      );
      if (captured.kind === "isolated") {
        const observed = yield* capture(recovery.recoveryWorktreePath, "isolated").pipe(
          Effect.mapError(() => new NativeWorkerWorktreeRemovalError({ reason: "identity", ...recovery })),
        );
        if (
          observed.worktreeDev !== captured.worktreeDev ||
          observed.worktreeIno !== captured.worktreeIno ||
          observed.adminDev !== captured.adminDev ||
          observed.adminIno !== captured.adminIno
        ) return yield* new NativeWorkerWorktreeRemovalError({ reason: "identity", ...recovery });
      }
      return { ...recovery, recoveryLocationStatus: "verified" as const };
    });

  const remove: NativeWorkerWorktreeRemover["Service"]["remove"] = (worktreePath) =>
    capture(worktreePath).pipe(Effect.flatMap(removeCaptured));

  return NativeWorkerWorktreeRemover.of({
    capture,
    publishCaptured,
    removeCaptured,
    quarantineCaptured,
    remove,
  });
});

export const layer = Layer.effect(NativeWorkerWorktreeRemover, make());
