// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeCrypto from "node:crypto";
import {
  EnvironmentId, ModelSelection, ProjectId, ProviderInteractionMode,
  RepositoryIdentity, RuntimeMode, ThreadId, TrimmedNonEmptyString,
  WorkjetCapabilityId, WorkjetComputerId, WorkjetContentDigest, WorkjetExecutionPolicy,
} from "@workjet/contracts";
import { normalizeGitRemoteUrl } from "@workjet/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { WorktreeStorage } from "../worktree/WorktreeStorage.ts";
import { canonicalWorkerJson } from "./CanonicalWorkerJson.ts";
import { IsolatedWorkerWorktree } from "./IsolatedWorkerWorktree.ts";
import type { IsolatedWorkerWorktreeCustody } from "./IsolatedWorkerWorktreeStore.ts";

export const LocalWorkerWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  refName: TrimmedNonEmptyString,
  repository: RepositoryIdentity,
  context: Schema.Struct({
    schemaVersion: Schema.Literal(1),
    environmentId: EnvironmentId,
    computerId: Schema.optionalKey(WorkjetComputerId),
    parentThreadId: ThreadId,
    projectId: ProjectId,
    workerThreadId: ThreadId,
    teamRole: Schema.Literals(["supervisor", "specialist"]),
    teamParentThreadId: Schema.NullOr(ThreadId),
    taskDigest: WorkjetContentDigest,
    modelSelection: ModelSelection,
    enabledCapabilityIds: Schema.Array(WorkjetCapabilityId),
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    executionPolicy: WorkjetExecutionPolicy,
  }),
});
export type LocalWorkerWorktreeInput = typeof LocalWorkerWorktreeInput.Type;

export class LocalWorkerWorktreeError extends Schema.TaggedErrorClass<LocalWorkerWorktreeError>()(
  "LocalWorkerWorktreeError",
  { reason: Schema.Literals(["invalid", "repository", "dirty", "revision", "storage", "allocation"]) },
) {}
export class LocalWorkerWorktree extends Context.Service<
  LocalWorkerWorktree,
  {
    readonly allocate: (input: LocalWorkerWorktreeInput) => Effect.Effect<{
      readonly path: string; readonly refName: string; readonly custody: IsolatedWorkerWorktreeCustody;
    }, LocalWorkerWorktreeError>;
  }
>()("workjet/workjet/LocalWorkerWorktree") {}

const failure = (reason: LocalWorkerWorktreeError["reason"]) => new LocalWorkerWorktreeError({ reason });

/** This is a source-server preparation broker, not a provider execution
 * permit. It accepts only the saved project/team policy and a signed task
 * snapshot digest; every advertised provider policy mode remains unsupported. */
export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver;
  const isolated = yield* IsolatedWorkerWorktree;
  const storage = yield* WorktreeStorage;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const allocate = Effect.fn("LocalWorkerWorktree.allocate")(function* (raw: LocalWorkerWorktreeInput) {
    const input = yield* Schema.decodeUnknownEffect(LocalWorkerWorktreeInput)(raw).pipe(Effect.mapError(() => failure("invalid")));
    const context = input.context;
    if (
      context.executionPolicy.projectId !== context.projectId ||
      context.workerThreadId === context.parentThreadId ||
      (context.teamRole === "supervisor" ? context.teamParentThreadId !== null : context.teamParentThreadId === null) ||
      !path.isAbsolute(input.cwd) || path.resolve(input.cwd) !== input.cwd ||
      (yield* fs.realPath(input.cwd).pipe(Effect.mapError(() => failure("repository")))) !== input.cwd
    ) return yield* failure("invalid");
    const repository = input.repository;
    const remote = repository.locator.remoteUrl;
    const scp = /^git@([A-Za-z0-9.-]+):([^?#\s]+)$/.exec(remote);
    const locator = yield* Effect.try({
      try: () => new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote),
      catch: () => failure("repository"),
    });
    const url = locator.protocol === "ssh:" && locator.username === "git" && !locator.password && !locator.port
      ? new URL(`https://${locator.hostname}${locator.pathname}`) : locator;
    if (
      url.protocol !== "https:" || url.username || url.password || locator.search || locator.hash ||
      normalizeGitRemoteUrl(remote) !== repository.canonicalKey ||
      normalizeGitRemoteUrl(url.href) !== repository.canonicalKey
    ) return yield* failure("repository");
    const runGit = Effect.fn("LocalWorkerWorktree.git")(function* (args: ReadonlyArray<string>) {
      const result = yield* git.execute({
        operation: "LocalWorkerWorktree", cwd: input.cwd,
        args: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
        env: {
          ...Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith("GIT_")).map((key) => [key, undefined])),
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "0", GIT_ALTERNATE_OBJECT_DIRECTORIES: "", GIT_TEMPLATE_DIR: "",
        },
        timeoutMs: 120000, maxOutputBytes: 65536,
      }).pipe(Effect.mapError(() => failure("repository")));
      if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated)
        return yield* failure("repository");
      return result.stdout.trim();
    });
    // Query the actual remote instead of trusting a possibly cached resolver.
    const actualRemote = yield* runGit(["remote", "get-url", "--", repository.locator.remoteName]);
    if (normalizeGitRemoteUrl(actualRemote) !== repository.canonicalKey) return yield* failure("repository");
    if ((yield* runGit(["status", "--porcelain=v1", "--untracked-files=all"])) !== "")
      return yield* failure("dirty");
    const revision = yield* runGit(["rev-parse", "--verify", "--end-of-options", input.refName + "^{commit}"]).pipe(Effect.mapError(() => failure("revision")));
    if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(revision)) return yield* failure("revision");
    const common = yield* runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!path.isAbsolute(common) || (yield* fs.realPath(common).pipe(Effect.mapError(() => failure("repository")))) !== common)
      return yield* failure("repository");
    const branch = "workjet/worker/" + context.workerThreadId;
    const destination = yield* storage.resolveAutomaticPath({ cwd: input.cwd, gitCommonDir: common, ref: branch }).pipe(Effect.mapError(() => failure("storage")));
    const trustedRoots = yield* storage.trustedRoots;
    if (!path.isAbsolute(destination) || path.resolve(destination) !== destination || !trustedRoots.some((root) => {
      const relative = path.relative(root, destination);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    })) return yield* failure("storage");
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(Effect.mapError(() => failure("storage")));
    const wire = yield* Schema.encodeEffect(LocalWorkerWorktreeInput.fields.context)(context).pipe(Effect.mapError(() => failure("invalid")));
    const authorityDigest = NodeCrypto.createHash("sha256").update(canonicalWorkerJson(wire)).digest("hex");
    const custody = yield* isolated.allocate({
      workerId: context.workerThreadId, projectId: context.projectId,
      repositoryKey: repository.canonicalKey, repositoryUrl: url.href,
      sourceCwd: input.cwd, revision, branch, destination, authorityDigest,
    }).pipe(Effect.mapError(() => failure("allocation")));
    if (custody.kind !== "isolated" || custody.worktreePath !== destination || custody.adminPath !== path.join(destination, ".git"))
      return yield* failure("allocation");
    return { path: custody.worktreePath, refName: branch, custody };
  });
  return LocalWorkerWorktree.of({ allocate });
});
export const layer = Layer.effect(LocalWorkerWorktree, make);
