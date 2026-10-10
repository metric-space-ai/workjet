import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChangeRequest, ProjectId, ThreadId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as ProcessRunner from "../processRunner.ts";
import { SourceControlProvider } from "../sourceControl/SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorktreeStorage from "../worktree/WorktreeStorage.ts";
import * as Allocations from "./IsolatedWorkerWorktreeStore.ts";
import {
  NativeWorkerWorktreeRemover,
  NativeWorkerWorktreeRemovalError,
} from "./NativeWorkerWorktreeRemover.ts";
import * as Receipts from "./WorkerCleanupReceiptStore.ts";
import { make } from "./WorkerWorktreeCleanup.ts";

const processLayer = VcsProcess.layer.pipe(Layer.provide(ProcessRunner.layer));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "isolated-worker-cleanup-" });
  const source = path.join(root, "source");
  const workers = path.join(root, "workers");
  yield* fs.makeDirectory(source);
  yield* fs.makeDirectory(workers);
  const threadId = ThreadId.make("00000000-0000-4000-8000-00000000000a");
  const projectId = ProjectId.make("00000000-0000-4000-8000-00000000000b");
  const branch = "workjet/worker/" + threadId;
  const stage = path.join(workers, ".workjet-prepared-" + threadId + "-original");
  const destination = path.join(workers, "one");
  yield* fs.makeDirectory(stage);
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    vcs.run({
      operation: "IsolatedWorkerCleanup.test",
      command: "git",
      args,
      cwd,
      timeoutMs: 120000,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  for (const [cwd, initialBranch] of [
    [source, "main"],
    [stage, branch],
  ] as const) {
    yield* git(cwd, ["init", "--template=", "--initial-branch=" + initialBranch]);
    yield* git(cwd, ["config", "user.name", "Workjet test"]);
    yield* git(cwd, ["config", "user.email", "workjet-test@example.invalid"]);
    yield* fs.writeFileString(path.join(cwd, "result.txt"), "real committed result\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "Worker result"]);
  }
  // A same-named source ref must survive private repository retirement.
  yield* git(source, ["branch", branch]);
  const sourceRefs = (yield* git(source, ["show-ref"])).stdout;
  const head = (yield* git(stage, ["rev-parse", "HEAD"])).stdout.trim();
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
  const original = yield* capture(stage);
  const published = {
    ...original,
    worktreePath: destination,
    adminPath: path.join(destination, ".git"),
  };
  const recovery = destination + ".workjet-rejected-" + original.worktreeIno;
  const sqlLayer = NodeSqliteClient.layer({ filename: path.join(root, "state.sqlite") });
  const storeLayer = Allocations.layer.pipe(Layer.provide(sqlLayer));
  yield* runMigrations().pipe(Effect.provide(sqlLayer), Effect.orDie);
  const allocation: Allocations.IsolatedWorkerWorktreeIntent = {
    workerId: threadId,
    projectId,
    repositoryKey: "github.com/owner/project",
    repositoryUrl: "https://github.com/owner/project.git",
    sourceCwd: source,
    revision: head,
    branch,
    destination,
    authorityDigest: "b".repeat(64),
  };
  yield* Effect.gen(function* () {
    const store = yield* Allocations.IsolatedWorkerWorktreeStore;
    yield* store.reserve(allocation);
    yield* store.capture(threadId, original);
  }).pipe(Effect.provide(storeLayer));
  yield* fs.rename(stage, destination);

  const state = {
    workspaceRoot: source,
    merged: true,
    prHead: head,
    moves: 0,
    loseAck: false,
    failRemovalWrite: false,
    beforeLookup: (): Effect.Effect<void> => Effect.void,
    afterRecoveryHead: (): Effect.Effect<void> => Effect.void,
    recoveryHeadReads: 0,
  };
  // The native filesystem operation is simulated here. Its no-follow / atomic
  // rename behavior has separate Rust tests; this fixture tests real Git + SQL
  // orchestration and lost acknowledgements, not a new native qualification.
  const nativeLayer = Layer.mock(NativeWorkerWorktreeRemover)({
    capture: (cwd, kind) => {
      assert.equal(kind, "isolated");
      return capture(cwd).pipe(
        Effect.mapError(() => new NativeWorkerWorktreeRemovalError({ reason: "identity" })),
      );
    },
    quarantineCaptured: (captured, reference) =>
      Effect.gen(function* () {
        assert.deepEqual(captured, published);
        const expectedProof = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          schemaVersion: 1,
          kind: "isolated",
          reason: "rejected-dispatch",
          originalWorktreePath: destination,
          originalAdminPath: captured.adminPath,
          recoveryWorktreePath: recovery,
          recoveryAdminPath: path.join(recovery, ".git"),
          originalHeadOid: reference.headOid,
          originalBranchRef: reference.branchRef,
          worktreeIdentity: {
            dev: Number(captured.worktreeDev),
            ino: Number(captured.worktreeIno),
          },
          adminIdentity: { dev: Number(captured.adminDev), ino: Number(captured.adminIno) },
          automaticContentDeletion: false,
        });
        const result = {
          originalWorktreePath: destination,
          originalAdminPath: captured.adminPath,
          recoveryWorktreePath: recovery,
          recoveryAdminPath: path.join(recovery, ".git"),
          recoveryLocationStatus: "verified" as const,
        };
        if (!(yield* fs.exists(destination))) {
          const observed = yield* capture(recovery).pipe(Effect.option);
          const proof = yield* fs
            .readFileString(path.join(recovery, ".git", "workjet-rollback-receipt.json"))
            .pipe(Effect.option);
          const progress = yield* fs
            .readFileString(path.join(recovery, ".git", "workjet-rollback-progress.jsonl"))
            .pipe(Effect.option);
          if (
            Option.isNone(observed) ||
            observed.value.worktreeIno !== captured.worktreeIno ||
            observed.value.adminIno !== captured.adminIno ||
            Option.isNone(proof) ||
            proof.value !== expectedProof ||
            Option.isNone(progress) ||
            progress.value.trim().split("\n").at(-1) !==
              '{"phase":"checkout-and-admin-quarantined"}'
          )
            return yield* new NativeWorkerWorktreeRemovalError({ reason: "identity" });
          return result;
        }
        const observed = yield* capture(destination).pipe(Effect.option);
        if (
          Option.isNone(observed) ||
          observed.value.worktreeIno !== captured.worktreeIno ||
          observed.value.adminIno !== captured.adminIno
        )
          return yield* new NativeWorkerWorktreeRemovalError({ reason: "identity" });
        yield* fs.writeFileString(
          path.join(destination, ".git", "workjet-rollback-receipt.json"),
          expectedProof,
        );
        yield* fs.writeFileString(
          path.join(destination, ".git", "workjet-rollback-progress.jsonl"),
          '{"phase":"prepared"}\n{"phase":"checkout-and-admin-quarantined"}\n',
        );
        yield* fs.rename(destination, recovery);
        state.moves++;
        if (state.loseAck) {
          state.loseAck = false;
          return yield* new NativeWorkerWorktreeRemovalError({ reason: "failed" });
        }
        return result;
      }).pipe(Effect.mapError(() => new NativeWorkerWorktreeRemovalError({ reason: "failed" }))),

    removeCaptured: () =>
      Effect.die("Private repositories must be retained, not recursively removed"),
  });
  const receiptLayer = Layer.effect(
    Receipts.WorkerCleanupReceiptStore,
    Receipts.make.pipe(
      Effect.map((store) => ({
        ...store,
        markRemoved: (receipt: Receipts.VerifiedWorkerCleanup) => {
          if (state.failRemovalWrite) {
            state.failRemovalWrite = false;
            return Effect.fail(
              new Receipts.WorkerCleanupEvidenceError({ detail: "Injected lost SQL write" }),
            );
          }
          return store.markRemoved(receipt);
        },
      })),
    ),
  ).pipe(Layer.provide(sqlLayer));
  const unexpected = () => Effect.die("Unexpected provider operation");
  const provider = SourceControlProvider.of({
    kind: "github",
    listChangeRequests: () =>
      Effect.gen(function* () {
        yield* state.beforeLookup();
        return state.merged
          ? [
              ChangeRequest.make({
                provider: "github",
                number: 7,
                title: "Worker result",
                url: "https://example.test/pull/7",
                baseRefName: "main",
                headRefName: branch,
                headCommitOid: state.prHead,
                state: "merged",
                updatedAt: Option.none(),
              }),
            ]
          : [];
      }),
    getChangeRequest: unexpected,
    createChangeRequest: unexpected,
    getRepositoryCloneUrls: unexpected,
    createRepository: unexpected,
    getDefaultBranch: unexpected,
    checkoutChangeRequest: unexpected,
  });
  const services = Layer.mergeAll(
    storeLayer,
    receiptLayer,
    nativeLayer,
    WorktreeStorage.layerTest({ trustedRoots: [workers] }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadWorktreeCleanupContext: () =>
        Effect.succeed(
          Option.some({
            threadId,
            projectId,
            workspaceRoot: state.workspaceRoot,
            workjetRole: "worker",
            branch,
            worktreePath: destination,
            archivedAt: null,
          }),
        ),
    }),
    Layer.mock(GitWorkflowService)({
      invalidateLocalStatus: () => Effect.void,
      localStatus: ({ cwd }) =>
        Effect.gen(function* () {
          const refName = (yield* git(cwd, ["branch", "--show-current"])).stdout.trim();
          const changes = (yield* git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]))
            .stdout;
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName,
            hasWorkingTreeChanges: changes !== "",
            workingTree: { files: [], insertions: 0, deletions: 0 },
          };
        }).pipe(
          Effect.orElseSucceed(() => ({
            isRepo: false,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          })),
        ),
    }),
    Layer.mock(GitVcsDriver)({
      resolveCommit: ({ cwd, revision }) =>
        git(cwd, ["rev-parse", revision]).pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (cwd === recovery && ++state.recoveryHeadReads === 2)
                yield* state.afterRecoveryHead();
              return { commitSha: result.stdout.trim() };
            }),
          ),
          Effect.orDie,
        ),
      deleteBranchAtCommit: () => Effect.die("Private cleanup must not delete source refs"),
    }),
    Layer.mock(SourceControlProviderRegistry)({
      resolve: () => Effect.succeed(provider),
    }),
  );
  const clean = () =>
    Effect.gen(function* () {
      const service = yield* make();
      return yield* service.cleanupDeletedThread(threadId);
    }).pipe(Effect.provide(services));
  const receipt = () =>
    Effect.gen(function* () {
      return Option.getOrThrow(yield* (yield* Receipts.WorkerCleanupReceiptStore).get(threadId));
    }).pipe(Effect.provide(receiptLayer));
  const verifySource = () =>
    Effect.gen(function* () {
      assert.equal((yield* git(source, ["show-ref"])).stdout, sourceRefs);
      assert.equal(
        yield* fs.readFileString(path.join(source, "result.txt")),
        "real committed result\n",
      );
    });
  return {
    fs,
    path,
    source,
    destination,
    recovery,
    git,
    state,
    clean,
    receipt,
    verifySource,
    head,
    original,
  };
});
const test = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(processLayer.pipe(Layer.provideMerge(NodeServices.layer))),
  );

it.effect(
  "retires the merged private checkout, retains its history and preserves every source ref",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* fixture;
        assert.deepEqual(yield* h.clean(), {
          status: "cleaned",
          worktreePath: h.destination,
          deletedRefName: null,
          retainedRepositoryPath: h.recovery,
        });
        assert.equal(yield* h.fs.exists(h.destination), false);
        assert.equal((yield* h.git(h.recovery, ["rev-parse", "HEAD"])).stdout.trim(), h.head);
        assert.equal(
          yield* h.fs.readFileString(h.path.join(h.recovery, "result.txt")),
          "real committed result\n",
        );
        assert.equal((yield* h.receipt()).status, "complete");
        yield* h.verifySource();
        assert.deepEqual(yield* h.clean(), { status: "skipped", reason: "already-cleaned" });
        assert.equal(h.state.moves, 1);
      }),
    ),
);

it.effect("retires a child seeded from a Parent worktree while preserving the project and Parent refs", () =>
  test(Effect.gen(function* () {
    const h = yield* fixture;
    const projectWorkspace = h.path.join(h.path.dirname(h.source), "project");
    yield* h.git(h.source, ["worktree", "add", "--detach", projectWorkspace, "HEAD"]);
    const projectHead = (yield* h.git(projectWorkspace, ["rev-parse", "HEAD"])).stdout;
    h.state.workspaceRoot = projectWorkspace;
    assert.equal((yield* h.clean()).status, "cleaned");
    assert.equal((yield* h.receipt()).status, "complete");
    yield* h.verifySource();
    assert.equal((yield* h.git(projectWorkspace, ["rev-parse", "HEAD"])).stdout, projectHead);
    assert.equal(yield* h.fs.readFileString(h.path.join(projectWorkspace, "result.txt")), "real committed result\n");
    assert.equal(yield* h.fs.exists(h.recovery), true);
  })),
);


for (const failure of ["loseAck", "failRemovalWrite"] as const) {
  it.effect(
    "recovers after " + failure + " using the original persisted capture and terminal native proof",
    () =>
      test(
        Effect.gen(function* () {
          const h = yield* fixture;
          h.state[failure] = true;
          yield* h.clean().pipe(Effect.flip);
          assert.equal((yield* h.receipt()).status, "verified");
          assert.equal(yield* h.fs.exists(h.destination), false);
          assert.equal((yield* h.clean()).status, "cleaned");
          assert.equal((yield* h.receipt()).status, "complete");
          assert.equal(h.state.moves, 1);
          yield* h.verifySource();
        }),
      ),
  );
}

for (const mismatch of ["unmerged", "other-head", "late-edit"] as const) {
  it.effect("preserves private source after " + mismatch, () =>
    test(
      Effect.gen(function* () {
        const h = yield* fixture;
        if (mismatch === "unmerged") h.state.merged = false;
        if (mismatch === "other-head") h.state.prHead = "b".repeat(40);
        if (mismatch === "late-edit")
          h.state.beforeLookup = () =>
            h.fs
              .writeFileString(h.path.join(h.destination, "result.txt"), "late user edit\n")
              .pipe(Effect.orDie);
        assert.deepEqual(yield* h.clean(), { status: "skipped", reason: "merge-unverified" });
        assert.equal(yield* h.fs.exists(h.destination), true);
        assert.equal(h.state.moves, 0);
        yield* h.verifySource();
      }),
    ),
  );
}

it.effect("refuses a replacement directory installed during the merge lookup", () =>
  test(
    Effect.gen(function* () {
      const h = yield* fixture;
      h.state.beforeLookup = () =>
        Effect.gen(function* () {
          yield* h.fs.rename(h.destination, h.destination + "-original");
          yield* h.fs.makeDirectory(h.path.join(h.destination, ".git"), { recursive: true });
          yield* h.fs.writeFileString(
            h.path.join(h.destination, "foreign.txt"),
            "retain replacement\n",
          );
        }).pipe(Effect.orDie);
      assert.deepEqual(yield* h.clean(), { status: "skipped", reason: "merge-unverified" });
      assert.equal(h.state.moves, 0);
      assert.equal(
        yield* h.fs.readFileString(h.path.join(h.destination, "foreign.txt")),
        "retain replacement\n",
      );
      yield* h.verifySource();
    }),
  ),
);

for (const corruption of [
  "missing-terminal-proof",
  "wrong-native-head",
  "replaced-recovery",
] as const) {
  it.effect("does not complete recovery after " + corruption, () =>
    test(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.state.loseAck = true;
        yield* h.clean().pipe(Effect.flip);
        if (corruption === "missing-terminal-proof") {
          yield* h.fs.writeFileString(
            h.path.join(h.recovery, ".git", "workjet-rollback-progress.jsonl"),
            '{"phase":"prepared"}\n',
          );
        } else if (corruption === "wrong-native-head") {
          const file = h.path.join(h.recovery, ".git", "workjet-rollback-receipt.json");
          const text = yield* h.fs.readFileString(file);
          yield* h.fs.writeFileString(
            file,
            text.replace(
              '"originalHeadOid":"' + h.head + '"',
              '"originalHeadOid":"' + "b".repeat(40) + '"',
            ),
          );
        } else {
          yield* h.fs.rename(h.recovery, h.recovery + "-original");
          yield* h.fs.makeDirectory(h.path.join(h.recovery, ".git"), { recursive: true });
          yield* h.fs.writeFileString(
            h.path.join(h.recovery, "foreign.txt"),
            "retain recovery replacement\n",
          );
        }
        assert.deepEqual(yield* h.clean(), {
          status: "skipped",
          reason: "safe-removal-unavailable",
        });
        assert.equal((yield* h.receipt()).status, "verified");
        assert.equal(h.state.moves, 1);
        yield* h.verifySource();
      }),
    ),
  );
}

it.effect("rejects recovery replaced after its terminal proof and Git HEAD checks", () =>
  test(
    Effect.gen(function* () {
      const h = yield* fixture;
      h.state.loseAck = true;
      yield* h.clean().pipe(Effect.flip);
      h.state.afterRecoveryHead = () =>
        Effect.gen(function* () {
          yield* h.fs.rename(h.recovery, h.recovery + "-original");
          yield* h.fs.makeDirectory(h.path.join(h.recovery, ".git"), { recursive: true });
          yield* h.fs.writeFileString(
            h.path.join(h.recovery, "foreign.txt"),
            "late recovery replacement\n",
          );
        }).pipe(Effect.orDie);
      assert.deepEqual(yield* h.clean(), { status: "skipped", reason: "safe-removal-unavailable" });
      assert.equal((yield* h.receipt()).status, "verified");
      assert.equal(h.state.moves, 1);
      assert.equal(
        yield* h.fs.readFileString(h.path.join(h.recovery, "foreign.txt")),
        "late recovery replacement\n",
      );
      yield* h.verifySource();
    }),
  ),
);
