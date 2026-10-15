import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { GitCommandError } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProcessRunner from "../processRunner.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { IsolatedWorkerWorktree, layer } from "./IsolatedWorkerWorktree.ts";
import {
  NativeWorkerWorktreeRemover,
  NativeWorkerWorktreeRemovalError,
} from "./NativeWorkerWorktreeRemover.ts";
import * as Store from "./IsolatedWorkerWorktreeStore.ts";

const processLayer = VcsProcess.layer.pipe(Layer.provide(ProcessRunner.layer));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "isolated-worker-git-" });
  const source = path.join(root, "source");
  const workers = path.join(root, "workers");
  yield* fs.makeDirectory(source);
  yield* fs.makeDirectory(workers);
  const git = (cwd: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    vcs.run({
      operation: "IsolatedWorkerWorktree.test",
      command: "git",
      args,
      cwd,
      allowNonZeroExit,
      timeoutMs: 120000,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  yield* git(source, ["init", "--template=", "--initial-branch=main"]);
  yield* git(source, ["config", "user.name", "Workjet test"]);
  yield* git(source, ["config", "user.email", "workjet-test@example.invalid"]);
  yield* fs.writeFileString(path.join(source, "visible.txt"), "first\n");
  yield* fs.writeFileString(path.join(source, ".gitattributes"), "visible.txt filter=external\n");
  yield* git(source, ["add", "."]);
  yield* git(source, ["commit", "-m", "first"]);
  yield* fs.writeFileString(path.join(source, "visible.txt"), "approved\n");
  yield* git(source, ["commit", "-am", "approved"]);
  const revision = (yield* git(source, ["rev-parse", "HEAD"])).stdout.trim();
  yield* git(source, ["checkout", "-b", "unrelated"]);
  yield* fs.writeFileString(path.join(source, "unrelated.txt"), "must not seed this branch\n");
  yield* git(source, ["add", "."]);
  yield* git(source, ["commit", "-m", "unrelated"]);
  const unrelated = (yield* git(source, ["rev-parse", "HEAD"])).stdout.trim();
  yield* git(source, ["config", "filter.external.smudge", "false"]);
  yield* git(source, ["config", "core.fsmonitor", "false"]);
  yield* git(source, ["config", "remote.origin.url", "https://github.com/foreign/other.git"]);
  const initialRefs = (yield* git(source, ["show-ref"])).stdout;
  const state = { publishes: 0, loseAck: false, beforePublish: false, gitCalls: 0 };
  const capture = (worktreePath: string) =>
    Effect.gen(function* () {
      const adminPath = path.join(worktreePath, ".git");
      const [tree, admin] = yield* Effect.all([fs.stat(worktreePath), fs.stat(adminPath)]);
      assert.equal(yield* fs.realPath(worktreePath), worktreePath);
      assert.equal(yield* fs.realPath(adminPath), adminPath);
      assert.equal(tree.type, "Directory");
      assert.equal(admin.type, "Directory");
      return {
        kind: "isolated" as const,
        worktreePath,
        adminPath,
        worktreeDev: String(tree.dev),
        worktreeIno: String(Option.getOrThrow(tree.ino)),
        adminDev: String(admin.dev),
        adminIno: String(Option.getOrThrow(admin.ino)),
      };
    });
  const storedReceipt = () =>
    Effect.gen(function* () {
      return Option.getOrThrow(yield* (yield* Store.IsolatedWorkerWorktreeStore).get("worker-one"));
    }).pipe(
      Effect.provide(
        Store.layer.pipe(
          Layer.provide(NodeSqliteClient.layer({ filename: path.join(root, "state.sqlite") })),
        ),
      ),
    );
  const native = Layer.mock(NativeWorkerWorktreeRemover)({
    capture: (cwd, kind) => {
      assert.equal(kind, "isolated");
      return capture(cwd).pipe(
        Effect.mapError(() => new NativeWorkerWorktreeRemovalError({ reason: "identity" })),
      );
    },
    publishCaptured: (captured, destination) =>
      Effect.gen(function* () {
        state.publishes++;
        assert.deepEqual(yield* capture(captured.worktreePath), captured);
        const receipt = yield* storedReceipt();
        assert.deepEqual(receipt.custody, captured);
        if (state.beforePublish) {
          state.beforePublish = false;
          return yield* new NativeWorkerWorktreeRemovalError({ reason: "failed" });
        }
        assert.equal(yield* fs.exists(destination), false);
        yield* fs.rename(captured.worktreePath, destination);
        if (state.loseAck) {
          state.loseAck = false;
          return yield* new NativeWorkerWorktreeRemovalError({ reason: "failed" });
        }
        return {
          ...captured,
          worktreePath: destination,
          adminPath: path.join(destination, ".git"),
        };
      }).pipe(Effect.mapError(() => new NativeWorkerWorktreeRemovalError({ reason: "failed" }))),
  });
  const driver = Layer.mock(GitVcsDriver)({
    execute: (input) => {
      state.gitCalls++;
      return vcs.run({ ...input, command: "git" }).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: input.operation,
              command: "git",
              cwd: input.cwd,
              detail: String(cause),
            }),
        ),
      );
    },
  });
  const intent: Store.IsolatedWorkerWorktreeIntent = {
    workerId: "worker-one",
    projectId: "project",
    repositoryKey: "github.com/owner/project",
    repositoryUrl: "https://github.com/owner/project.git",
    sourceCwd: source,
    revision,
    branch: "workjet/worker/worker-one",
    destination: path.join(workers, "one"),
    authorityDigest: "b".repeat(64),
  };
  const runtime = () =>
    layer.pipe(
      Layer.provideMerge(Store.layer),
      Layer.provide(native),
      Layer.provide(driver),
      Layer.provideMerge(NodeSqliteClient.layer({ filename: path.join(root, "state.sqlite") })),
    );
  const allocate = () =>
    Effect.gen(function* () {
      yield* runMigrations().pipe(Effect.orDie);
      return yield* (yield* IsolatedWorkerWorktree).allocate(intent);
    }).pipe(Effect.provide(runtime()));
  const receipt = () =>
    Effect.gen(function* () {
      return Option.getOrThrow(
        yield* (yield* Store.IsolatedWorkerWorktreeStore).get(intent.workerId),
      );
    }).pipe(Effect.provide(runtime()));
  return {
    fs,
    path,
    root,
    source,
    workers,
    git,
    initialRefs,
    unrelated,
    state,
    intent,
    allocate,
    receipt,
  };
});
const test = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(processLayer.pipe(Layer.provideMerge(NodeServices.layer))),
  );

it.effect(
  "seeds a private Git history without other branches, source configuration or alternates",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* fixture;
        const worker = yield* h.allocate();
        assert.equal(worker.kind, "isolated");
        assert.equal(worker.worktreePath, h.intent.destination);
        assert.equal(
          yield* h.fs.readFileString(h.path.join(worker.worktreePath, "visible.txt")),
          "approved\n",
        );
        assert.equal(
          (yield* h.git(worker.worktreePath, ["rev-parse", "HEAD"])).stdout.trim(),
          h.intent.revision,
        );
        assert.equal(
          (yield* h.git(worker.worktreePath, ["show-ref"])).stdout.trim(),
          h.intent.revision + " refs/heads/" + h.intent.branch,
        );
        assert.notEqual(
          (yield* h.git(worker.worktreePath, ["cat-file", "-e", h.unrelated], true)).exitCode,
          0,
        );
        assert.notEqual(
          (yield* h.git(worker.worktreePath, ["config", "--local", "--get", "user.email"], true))
            .exitCode,
          0,
        );
        assert.notEqual(
          (yield* h.git(
            worker.worktreePath,
            ["config", "--local", "--get", "filter.external.smudge"],
            true,
          )).exitCode,
          0,
        );
        assert.equal(
          yield* h.fs.exists(h.path.join(worker.adminPath, "objects/info/alternates")),
          false,
        );
        yield* h.git(worker.worktreePath, ["config", "--local", "user.name", "Worker"]);
        yield* h.git(worker.worktreePath, [
          "config",
          "--local",
          "user.email",
          "worker@example.invalid",
        ]);
        yield* h.fs.writeFileString(
          h.path.join(worker.worktreePath, "visible.txt"),
          "worker change\n",
        );
        yield* h.git(worker.worktreePath, ["commit", "-am", "worker only"]);
        assert.equal((yield* h.git(h.source, ["show-ref"])).stdout, h.initialRefs);
        assert.equal(
          yield* h.fs.readFileString(h.path.join(h.source, "visible.txt")),
          "approved\n",
        );
      }),
    ),
);

it.effect(
  "recovers a lost publication acknowledgement with the original identities after a restart",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.state.loseAck = true;
        assert.equal((yield* Effect.flip(h.allocate())).reason, "publication");
        const original = (yield* h.receipt()).custody;
        assert.ok(original !== null);
        const recovered = yield* h.allocate();
        assert.equal(h.state.publishes, 1);
        assert.equal(recovered.worktreeIno, original.worktreeIno);
        assert.equal(recovered.adminIno, original.adminIno);
        assert.equal(yield* h.fs.exists(original.worktreePath), false);
        assert.deepEqual((yield* h.receipt()).custody, original);
      }),
    ),
);

it.effect("resumes a captured but unpublished checkout rather than preparing a second one", () =>
  test(
    Effect.gen(function* () {
      const h = yield* fixture;
      h.state.beforePublish = true;
      assert.equal((yield* Effect.flip(h.allocate())).reason, "publication");
      const original = (yield* h.receipt()).custody;
      assert.ok(original !== null);
      assert.equal(yield* h.fs.exists(original.worktreePath), true);
      const recovered = yield* h.allocate();
      assert.equal(recovered.worktreeIno, original.worktreeIno);
      assert.equal(h.state.publishes, 2);
      assert.deepEqual(yield* h.fs.readDirectory(h.workers), ["one"]);
    }),
  ),
);

it.effect("refuses a replaced destination while preserving both repositories", () =>
  test(
    Effect.gen(function* () {
      const h = yield* fixture;
      yield* h.allocate();
      const retained = h.intent.destination + "-retained";
      yield* h.fs.rename(h.intent.destination, retained);
      yield* h.git(h.workers, ["clone", "--no-hardlinks", "--", retained, h.intent.destination]);
      assert.equal((yield* Effect.flip(h.allocate())).reason, "identity");
      assert.equal(yield* h.fs.exists(h.path.join(retained, "visible.txt")), true);
      assert.equal(yield* h.fs.exists(h.path.join(h.intent.destination, "visible.txt")), true);
      assert.equal(h.state.publishes, 1);
    }),
  ),
);

it.effect("never adopts an existing directory without pre-publication custody", () =>
  test(
    Effect.gen(function* () {
      const h = yield* fixture;
      yield* h.fs.makeDirectory(h.intent.destination);
      yield* h.fs.writeFileString(
        h.path.join(h.intent.destination, "owned-by-someone-else"),
        "keep",
      );
      assert.equal((yield* Effect.flip(h.allocate())).reason, "identity");
      assert.equal(h.state.gitCalls, 0);
      assert.equal((yield* h.receipt()).custody, null);
      assert.equal(
        yield* h.fs.readFileString(h.path.join(h.intent.destination, "owned-by-someone-else")),
        "keep",
      );
    }),
  ),
);

it.effect("keeps a missing original capture as a failure instead of creating a new checkout", () =>
  test(
    Effect.gen(function* () {
      const h = yield* fixture;
      h.state.beforePublish = true;
      yield* Effect.flip(h.allocate());
      const original = (yield* h.receipt()).custody;
      assert.ok(original !== null);
      yield* h.fs.rename(original.worktreePath, original.worktreePath + "-retained");
      assert.equal((yield* Effect.flip(h.allocate())).reason, "identity");
      assert.equal(yield* h.fs.exists(h.intent.destination), false);
      assert.equal(h.state.publishes, 1);
    }),
  ),
);

it.effect(
  "ignores inherited Git redirects, config injection and external templates during preparation",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* fixture;
        const variables = {
          GIT_DIR: h.path.join(h.source, ".git"),
          GIT_WORK_TREE: h.source,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "filter.external.smudge",
          GIT_CONFIG_VALUE_0: "false",
          GIT_TEMPLATE_DIR: h.source,
        };
        const captured = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const previous = Object.fromEntries(
              Object.keys(variables).map((key) => [key, process.env[key]]),
            );
            Object.assign(process.env, variables);
            return previous;
          }),
          () => h.allocate(),
          (previous) =>
            Effect.sync(() => {
              for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
            }),
        );
        assert.equal(captured.worktreePath, h.intent.destination);
        assert.equal(
          yield* h.fs.readFileString(h.path.join(captured.worktreePath, "visible.txt")),
          "approved\n",
        );
        assert.equal((yield* h.git(h.source, ["show-ref"])).stdout, h.initialRefs);
      }),
    ),
);
