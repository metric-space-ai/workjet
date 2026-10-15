import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitCommandError } from "@workjet/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  DEFAULT_MODEL,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkjetCapabilityId,
  WorkjetContentDigest,
} from "@workjet/contracts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitVcsDriver, type ExecuteGitInput } from "../vcs/GitVcsDriver.ts";
import { WorktreeStorage } from "../worktree/WorktreeStorage.ts";
import { IsolatedWorkerWorktree } from "./IsolatedWorkerWorktree.ts";
import type { IsolatedWorkerWorktreeIntent } from "./IsolatedWorkerWorktreeStore.ts";
import { make, type LocalWorkerWorktreeInput } from "./LocalWorkerWorktree.ts";

const processLayer = VcsProcess.layer.pipe(Layer.provide(ProcessRunner.layer));

it.effect(
  "checks an actual parent commit and remote while retaining ignored files and rejecting pending work",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcs = yield* VcsProcess.VcsProcess;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "local-worker-source-" });
      const root = yield* fs.realPath(temporary);
      const source = path.join(root, "source");
      const workers = path.join(root, "workers");
      yield* fs.makeDirectory(source);
      const git = (args: ReadonlyArray<string>) =>
        vcs.run({
          operation: "LocalWorkerWorktree.test",
          command: "git",
          cwd: source,
          args,
          env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          timeoutMs: 120000,
        });
      yield* git(["init", "--template=", "--initial-branch=main"]);
      yield* git(["config", "user.name", "Workjet test"]);
      yield* git(["config", "user.email", "workjet-test@example.invalid"]);
      yield* fs.writeFileString(path.join(source, "visible.txt"), "approved\n");
      yield* fs.writeFileString(path.join(source, ".gitignore"), "cache/\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "approved"]);
      const revision = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
      yield* git(["remote", "add", "origin", input.repository.locator.remoteUrl]);
      yield* git(["config", "core.fsmonitor", "false"]);
      yield* fs.makeDirectory(path.join(source, "cache"));
      yield* fs.writeFileString(path.join(source, "cache", "retained"), "ignored dependency data");
      const allocated: IsolatedWorkerWorktreeIntent[] = [];
      const allocateAt = path.join(workers, "worker-one");
      const service = yield* make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(GitVcsDriver)({
              execute: (command) =>
                vcs.run({ ...command, command: "git", allowNonZeroExit: true }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitCommandError({
                        operation: command.operation,
                        command: "git",
                        cwd: command.cwd,
                        detail: String(cause),
                      }),
                  ),
                ),
            }),
            Layer.mock(WorktreeStorage)({
              resolveAutomaticPath: () => Effect.succeed(allocateAt),
              trustedRoots: Effect.succeed([workers]),
            }),
            Layer.succeed(IsolatedWorkerWorktree, {
              allocate: (intent) =>
                Effect.sync(() => {
                  allocated.push(intent);
                  return { ...custody, worktreePath: allocateAt, adminPath: allocateAt + "/.git" };
                }),
            }),
          ),
        ),
      );
      yield* service.allocate({ ...input, cwd: source, refName: "main" });
      assert.equal(allocated[0]?.revision, revision);
      assert.equal(allocated[0]?.sourceCwd, source);
      assert.equal(
        yield* fs.readFileString(path.join(source, "cache", "retained")),
        "ignored dependency data",
      );
      yield* fs.writeFileString(path.join(source, "pending.txt"), "uncommitted");
      assert.equal(
        (yield* Effect.flip(service.allocate({ ...input, cwd: source, refName: "main" }))).reason,
        "dirty",
      );
      assert.equal(allocated.length, 1);
      yield* fs.remove(path.join(source, "pending.txt"));
      yield* git(["remote", "set-url", "origin", "https://github.com/foreign/project.git"]);
      assert.equal(
        (yield* Effect.flip(service.allocate({ ...input, cwd: source, refName: "main" }))).reason,
        "repository",
      );
      assert.equal(allocated.length, 1);
    }).pipe(Effect.provide(processLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

const input: LocalWorkerWorktreeInput = {
  cwd: "/source/project",
  refName: "feature/parent",
  repository: {
    canonicalKey: "github.com/owner/project",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:owner/project.git",
    },
  },
  context: {
    schemaVersion: 1,
    environmentId: EnvironmentId.make("source"),
    parentThreadId: ThreadId.make("parent"),
    projectId: ProjectId.make("project"),
    workerThreadId: ThreadId.make("worker-one"),
    teamRole: "specialist",
    teamParentThreadId: ThreadId.make("supervisor"),
    taskDigest: WorkjetContentDigest.make("a".repeat(64)),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
    enabledCapabilityIds: [WorkjetCapabilityId.make("greppy")],
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    executionPolicy: {
      mode: "autonomous-worktree",
      projectId: ProjectId.make("project"),
      revision: 7,
    },
  },
};
const destination = "/workers/project/workjet-worker-worker-one";
const custody = {
  kind: "isolated" as const,
  worktreePath: destination,
  adminPath: destination + "/.git",
  worktreeDev: "1",
  worktreeIno: "2",
  adminDev: "1",
  adminIno: "3",
};
const fixture = () => {
  const allocations: IsolatedWorkerWorktreeIntent[] = [];
  const commands: ExecuteGitInput[] = [];
  const directories: string[] = [];
  const state = {
    remote: "git@github.com:owner/project.git",
    dirty: "",
    head: "b".repeat(40),
    common: "/source/project/.git",
    root: "/workers",
    destination,
    realPathSuffix: "",
    truncated: false,
    wrongCapture: false,
  };
  const layers = Layer.mergeAll(
    Layer.mock(GitVcsDriver)({
      execute: (command) =>
        Effect.sync(() => {
          commands.push(command);
          const args = command.args.slice(4);
          const stdout =
            args[0] === "remote"
              ? state.remote
              : args[0] === "status"
                ? state.dirty
                : args.includes("--verify")
                  ? state.head
                  : state.common;
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout,
            stderr: "",
            stdoutTruncated: state.truncated,
            stderrTruncated: false,
          };
        }),
    }),
    Layer.succeed(IsolatedWorkerWorktree, {
      allocate: (intent) =>
        Effect.sync(() => {
          allocations.push(intent);
          return {
            ...custody,
            worktreePath: state.wrongCapture ? "/foreign/worker" : intent.destination,
          };
        }),
    }),
    Layer.mock(WorktreeStorage)({
      resolveAutomaticPath: () => Effect.succeed(state.destination),
      trustedRoots: Effect.sync(() => [state.root]),
    }),
    FileSystem.layerNoop({
      realPath: (path) => Effect.succeed(path + state.realPathSuffix),
      makeDirectory: (path) =>
        Effect.sync(() => {
          directories.push(path);
        }),
    }),
    Path.layer,
  );
  return { service: make.pipe(Effect.provide(layers)), allocations, commands, directories, state };
};

it.effect(
  "uses the saved repository, exact parent commit and server storage for private allocation",
  () =>
    Effect.gen(function* () {
      const h = fixture();
      const service = yield* h.service;
      const worker = yield* service.allocate(input);
      assert.deepEqual(worker, {
        path: destination,
        refName: "workjet/worker/worker-one",
        custody,
      });
      assert.deepEqual(h.allocations[0], {
        workerId: "worker-one",
        projectId: input.context.projectId,
        repositoryKey: input.repository.canonicalKey,
        repositoryUrl: "https://github.com/owner/project.git",
        sourceCwd: input.cwd,
        revision: h.state.head,
        branch: "workjet/worker/worker-one",
        destination,
        authorityDigest: h.allocations[0]!.authorityDigest,
      });
      assert.match(h.allocations[0]!.authorityDigest, /^[a-f0-9]{64}$/);
      assert.equal(h.commands[2]?.args.at(-1), "feature/parent^{commit}");
      assert.ok(h.commands[2]?.args.includes("--end-of-options"));
      assert.equal(h.commands[0]?.env?.GIT_CONFIG_COUNT, "0");
      assert.equal(h.commands[0]?.env?.GIT_CONFIG_GLOBAL, "/dev/null");
    }),
);

it.effect(
  "binds the digest to exact policy, team provenance, task, model and capability order",
  () =>
    Effect.gen(function* () {
      const h = fixture();
      const service = yield* h.service;
      yield* service.allocate(input);
      const original = h.allocations[0]!.authorityDigest;
      const reordered = {
        ...input,
        context: {
          ...input.context,
          executionPolicy: {
            revision: 7,
            projectId: input.context.projectId,
            mode: "autonomous-worktree" as const,
          },
        },
      };
      yield* service.allocate(reordered);
      assert.equal(h.allocations[1]!.authorityDigest, original);
      for (const context of [
        { ...input.context, executionPolicy: { ...input.context.executionPolicy, revision: 8 } },
        { ...input.context, parentThreadId: ThreadId.make("another-parent") },
        { ...input.context, taskDigest: WorkjetContentDigest.make("c".repeat(64)) },
        {
          ...input.context,
          modelSelection: {
            ...input.context.modelSelection,
            instanceId: ProviderInstanceId.make("another-codex-instance"),
          },
        },
        {
          ...input.context,
          enabledCapabilityIds: [
            WorkjetCapabilityId.make("web-search"),
            ...input.context.enabledCapabilityIds,
          ],
        },
      ]) {
        yield* service.allocate({ ...input, context });
        assert.notEqual(h.allocations.at(-1)!.authorityDigest, original);
      }
    }),
);

for (const [name, change, reason] of [
  ["foreign remote", { remote: "https://github.com/foreign/project.git" }, "repository"],
  ["dirty tracked or untracked work", { dirty: " M retained.txt\n" }, "dirty"],
  ["truncated repository data", { truncated: true }, "repository"],
  ["missing commit", { head: "missing" }, "revision"],
  ["untrusted destination", { destination: "/foreign/worker" }, "storage"],
  ["replaced source or Git directory", { realPathSuffix: "-replacement" }, "invalid"],
] as const)
  it.effect("rejects " + name + " before allocating or publishing", () =>
    Effect.gen(function* () {
      const h = fixture();
      Object.assign(h.state, change);
      const service = yield* h.service;
      assert.equal((yield* Effect.flip(service.allocate(input))).reason, reason);
      assert.deepEqual(h.allocations, []);
      assert.deepEqual(h.directories, []);
    }),
  );

it.effect("rejects credential-bearing locators and foreign/invalid project team policies", () =>
  Effect.gen(function* () {
    for (const invalid of [
      {
        ...input,
        repository: {
          ...input.repository,
          locator: {
            ...input.repository.locator,
            remoteUrl: "https://user:secret@github.com/owner/project.git",
          },
        },
      },
      {
        ...input,
        context: {
          ...input.context,
          executionPolicy: {
            ...input.context.executionPolicy,
            projectId: ProjectId.make("foreign"),
          },
        },
      },
      { ...input, context: { ...input.context, workerThreadId: input.context.parentThreadId } },
      { ...input, context: { ...input.context, teamRole: "supervisor" as const } },
    ]) {
      const h = fixture();
      const service = yield* h.service;
      yield* Effect.flip(service.allocate(invalid));
      assert.deepEqual(h.commands, []);
      assert.deepEqual(h.allocations, []);
    }
  }),
);

it.effect("refuses an allocator substituting another root or external Git metadata", () =>
  Effect.gen(function* () {
    const h = fixture();
    h.state.wrongCapture = true;
    const service = yield* h.service;
    assert.equal((yield* Effect.flip(service.allocate(input))).reason, "allocation");
  }),
);
