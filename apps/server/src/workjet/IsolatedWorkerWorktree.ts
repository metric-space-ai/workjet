// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeUtil from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { normalizeGitRemoteUrl } from "@workjet/shared/git";
import { NativeWorkerWorktreeRemover } from "./NativeWorkerWorktreeRemover.ts";
import {
  IsolatedWorkerWorktreeError,
  IsolatedWorkerWorktreeStore,
  type IsolatedWorkerWorktreeIntent,
  type IsolatedWorkerWorktreeCustody,
} from "./IsolatedWorkerWorktreeStore.ts";

export class IsolatedWorkerWorktree extends Context.Service<
  IsolatedWorkerWorktree,
  {
    readonly allocate: (
      intent: IsolatedWorkerWorktreeIntent,
    ) => Effect.Effect<IsolatedWorkerWorktreeCustody, IsolatedWorkerWorktreeError>;
  }
>()("workjet/workjet/IsolatedWorkerWorktree") {}

const failure = (reason: IsolatedWorkerWorktreeError["reason"]) =>
  new IsolatedWorkerWorktreeError({ reason });

export const make = Effect.gen(function* () {
  const store = yield* IsolatedWorkerWorktreeStore;
  const remover = yield* NativeWorkerWorktreeRemover;
  const git = yield* GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sanitizedGitEnvironment = (): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => key.startsWith("GIT_"))
        .map((key) => [key, undefined]),
    ),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0",
  });
  const gitEnvironment = (root: string, common = path.join(root, ".git")): NodeJS.ProcessEnv => ({
    ...sanitizedGitEnvironment(),
    GIT_DIR: common,
    GIT_COMMON_DIR: common,
    GIT_WORK_TREE: root,
    GIT_OBJECT_DIRECTORY: path.join(common, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
    GIT_INDEX_FILE: path.join(root, ".git", "index"),
    GIT_NAMESPACE: "",
    GIT_TEMPLATE_DIR: "",
  });
  const runGit = Effect.fn("IsolatedWorkerWorktree.git")(function* (
    root: string,
    args: ReadonlyArray<string>,
    options: { common?: string; stdin?: string } = {},
  ) {
    const result = yield* git
      .execute({
        operation: "IsolatedWorkerWorktree",
        cwd: root,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "gc.auto=0",
          ...args,
        ],
        env: gitEnvironment(root, options.common),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        timeoutMs: 120000,
        maxOutputBytes: 65536,
      })
      .pipe(Effect.mapError(() => failure("git")));
    if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated)
      return yield* failure("git");
    return result.stdout.trim();
  });
  const verify = Effect.fn("IsolatedWorkerWorktree.verify")(function* (
    captured: IsolatedWorkerWorktreeCustody,
    intent: IsolatedWorkerWorktreeIntent,
  ) {
    const observed = yield* remover
      .capture(captured.worktreePath, "isolated")
      .pipe(Effect.mapError(() => failure("identity")));
    if (!NodeUtil.isDeepStrictEqual(observed, captured)) return yield* failure("identity");
    for (const forbidden of [
      "commondir",
      "objects/info/alternates",
      "objects/info/http-alternates",
    ]) {
      if (
        yield* fs
          .exists(path.join(captured.adminPath, forbidden))
          .pipe(Effect.mapError(() => failure("identity")))
      )
        return yield* failure("identity");
    }
    if (
      (yield* runGit(captured.worktreePath, ["rev-parse", "HEAD"])) !== intent.revision ||
      (yield* runGit(captured.worktreePath, ["symbolic-ref", "HEAD"])) !==
        "refs/heads/" + intent.branch ||
      (yield* runGit(captured.worktreePath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored",
      ])) !== "" ||
      (yield* runGit(captured.worktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])) !== captured.adminPath ||
      (yield* runGit(captured.worktreePath, [
        "config",
        "--local",
        "--get",
        "remote.origin.url",
      ])) !== intent.repositoryUrl
    )
      return yield* failure("identity");
  });
  const allocate = Effect.fn("IsolatedWorkerWorktree.allocate")(function* (
    intent: IsolatedWorkerWorktreeIntent,
  ) {
    let url: URL;
    try {
      url = new URL(intent.repositoryUrl);
    } catch {
      return yield* failure("invalid");
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(intent.workerId) ||
      !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(intent.revision) ||
      !/^[a-f0-9]{64}$/.test(intent.authorityDigest) ||
      intent.branch !== "workjet/worker/" + intent.workerId ||
      !path.isAbsolute(intent.sourceCwd) ||
      path.resolve(intent.sourceCwd) !== intent.sourceCwd ||
      !path.isAbsolute(intent.destination) ||
      path.resolve(intent.destination) !== intent.destination ||
      intent.destination === intent.sourceCwd ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      normalizeGitRemoteUrl(intent.repositoryUrl) !== intent.repositoryKey
    )
      return yield* failure("invalid");
    let receipt = yield* store
      .reserve(intent)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "IsolatedWorkerWorktreeError" ? error : failure("unavailable"),
        ),
      );
    const parent = path.dirname(intent.destination);
    if ((yield* fs.realPath(parent).pipe(Effect.mapError(() => failure("identity")))) !== parent)
      return yield* failure("identity");
    if (receipt.custody === null) {
      if (yield* fs.exists(intent.destination).pipe(Effect.mapError(() => failure("identity"))))
        return yield* failure("identity");
      // No refs, configuration, alternates or hardlinks are copied from the source.
      const stage = yield* fs
        .makeTempDirectory({
          directory: parent,
          prefix: ".workjet-prepared-" + intent.workerId + "-",
        })
        .pipe(Effect.mapError(() => failure("unavailable")));
      yield* runGit(stage, [
        "init",
        "--template=",
        "--object-format=" + (intent.revision.length === 64 ? "sha256" : "sha1"),
        "--initial-branch=" + intent.branch,
      ]);
      const sourceCommon = yield* git
        .execute({
          operation: "IsolatedWorkerWorktree.source",
          cwd: intent.sourceCwd,
          args: [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ],
          env: sanitizedGitEnvironment(),
          timeoutMs: 120000,
        })
        .pipe(Effect.mapError(() => failure("git")));
      const common = sourceCommon.stdout.trim();
      if (
        sourceCommon.exitCode !== 0 ||
        sourceCommon.stdoutTruncated ||
        sourceCommon.stderrTruncated ||
        !path.isAbsolute(common) ||
        (yield* fs.realPath(common).pipe(Effect.mapError(() => failure("identity")))) !== common
      )
        return yield* failure("git");
      const pack = yield* runGit(
        intent.sourceCwd,
        [
          "pack-objects",
          "--revs",
          "--delta-base-offset",
          path.join(stage, ".git", "objects", "pack", "pack"),
        ],
        { common, stdin: intent.revision + "\n" },
      );
      if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(pack)) return yield* failure("git");
      yield* runGit(stage, ["config", "--local", "remote.origin.url", intent.repositoryUrl]);
      yield* runGit(stage, ["checkout", "-b", intent.branch, intent.revision, "--"]);
      const captured = yield* remover
        .capture(stage, "isolated")
        .pipe(Effect.mapError(() => failure("identity")));
      if (captured.kind !== "isolated") return yield* failure("identity");
      yield* verify({ ...captured, kind: "isolated" }, intent);
      // Record original identities BEFORE moving anything; never adopt a root
      // simply because it occupies the reserved path after a restart.
      receipt = yield* store
        .capture(intent.workerId, { ...captured, kind: "isolated" })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "IsolatedWorkerWorktreeError" ? error : failure("unavailable"),
          ),
        );
    }
    const captured = receipt.custody;
    if (
      captured === null ||
      path.dirname(captured.worktreePath) !== parent ||
      !path
        .basename(captured.worktreePath)
        .startsWith(".workjet-prepared-" + intent.workerId + "-") ||
      captured.adminPath !== path.join(captured.worktreePath, ".git")
    )
      return yield* failure("identity");
    const published = {
      ...captured,
      worktreePath: intent.destination,
      adminPath: path.join(intent.destination, ".git"),
    };
    if (yield* fs.exists(intent.destination).pipe(Effect.mapError(() => failure("identity")))) {
      yield* verify(published, intent);
      return published;
    }
    yield* verify(captured, intent);
    yield* remover
      .publishCaptured(captured, intent.destination)
      .pipe(Effect.mapError(() => failure("publication")));
    yield* verify(published, intent);
    return published;
  });
  return IsolatedWorkerWorktree.of({ allocate });
});
export const layer = Layer.effect(IsolatedWorkerWorktree, make);
