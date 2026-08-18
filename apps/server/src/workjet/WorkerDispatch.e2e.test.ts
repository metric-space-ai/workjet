/**
 * Real-stack proof for docs/workjet-plan.md section 18 item 15: a dispatched
 * orchestrated worker really runs in its own isolated Git worktree beneath the
 * operator-selected storage root.
 *
 * `WorkerDispatch.test.ts` proves the command shapes against fakes. That is not
 * proof of isolation, because a fake `createWorktree` can return any path it
 * likes. This file therefore boots the production layers and inspects the
 * filesystem and the real Git worktree registry.
 *
 * REAL layers (no substitutes):
 * - `GitVcsDriver` / `GitVcsDriverCore` — every `git` invocation is a real
 *   subprocess against a real temporary repository.
 * - `VcsDriverRegistry` (+ `VcsProjectConfig`, `VcsProcess`) — real repository
 *   detection and routing.
 * - `GitWorkflowService` — the production service under test.
 * - `WorktreeStorage` (+ `WorktreeRootValidation`) — real host validation and
 *   real automatic path derivation from the operator-selected root.
 * - `OrchestrationEngineService`, `OrchestrationProjectionPipeline`,
 *   `ProjectionSnapshotQuery`, the SQLite event store and command receipts —
 *   commands are validated, persisted and projected exactly as in production,
 *   so `worktreePath` is read back out of the real projection.
 * - `WorkerDispatch` itself, through `makeWorkerDispatch` / the injectable
 *   `makeWorkerDispatchWithSources` entry point.
 *
 * DOUBLES (deliberately, and none of them sits on the dispatch -> worktree path):
 * - `GitManager` — `Layer.mock(GitManager)({})`. `GitWorkflowService` requires
 *   the tag at construction time but `createWorktree` / `removeWorktree` never
 *   touch it; the mock dies loudly if that ever changes.
 * - `ServerSettingsService` — `serverSettings.layerTest({ automaticWorktreeRoot })`
 *   stands in for the settings file on disk. The setting value itself is real
 *   and is consumed by the real `WorktreeStorage`.
 * - `ServerConfig` — `ServerConfig.layerTest`, i.e. a real config over a
 *   temporary base directory.
 * - SQLite runs in memory (`SqlitePersistenceMemory`).
 * - No provider harness is booted. `thread.turn.start` is dispatched into the
 *   real engine, but no reactor layer is installed, so nothing spawns an LLM
 *   session. The proof target is dispatch -> worktree, not model output.
 *
 * The `thread.turn.start` rollback branch cannot be forced through the real
 * engine without a fake (the decider only rejects a turn for a missing thread,
 * and the worker thread exists by then); it stays covered unit-level in
 * `WorkerDispatch.test.ts`. The equivalent real-stack rollback proof here uses
 * the `create-failed` branch, which the real decider rejects via
 * `requireThreadAbsent` and which runs the very same worktree rollback.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import { GitWorkflowService, layer as gitWorkflowLayer } from "../git/GitWorkflowService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorktreeStorage from "../worktree/WorktreeStorage.ts";
import {
  makeWorkerDispatch,
  makeWorkerDispatchWithSources,
  WORKER_REF_PREFIX,
  type WorkerDispatchSources,
} from "./WorkerDispatch.ts";

/**
 * The operator-selected storage root and the project checkout must live on
 * different subtrees, because `WorktreeRootValidation` rejects a root nested in
 * the project, the home directory, or the server state directory.
 */
const REPOSITORY_CONTAINER = "/Volumes/tmp/workjet/e2e";
const WORKTREE_ROOT_CONTAINER = "/Volumes/tmp/workjet/e2e-worktrees";

const environmentId = EnvironmentId.make("environment-workjet-e2e");
const projectId = ProjectId.make("project-workjet-e2e");
const parentThreadId = ThreadId.make("thread-workjet-e2e-orchestrator");
const createdAt = "2026-08-18T00:00:00.000Z";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const satisfies ModelSelection;

const invocation: McpInvocationScope = {
  environmentId,
  threadId: parentThreadId,
  providerSessionId: "provider-session-e2e",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(),
  workjetRole: "orchestrator",
  issuedAt: 1,
};

interface Fixture {
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly baseDir: string;
}

const makeFixture = Effect.fn("WorkerDispatch.e2e.makeFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.forEach([REPOSITORY_CONTAINER, WORKTREE_ROOT_CONTAINER], (directory) =>
    fileSystem.makeDirectory(directory, { recursive: true }),
  );
  // Canonicalize so path comparisons survive any symlinked container.
  const container = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({
      directory: REPOSITORY_CONTAINER,
      prefix: "dispatch-",
    }),
  );
  const worktreeRoot = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({
      directory: WORKTREE_ROOT_CONTAINER,
      prefix: "root-",
    }),
  );
  const repositoryRoot = path.join(container, "repository");
  const baseDir = path.join(container, "server");
  yield* fileSystem.makeDirectory(repositoryRoot, { recursive: true });
  return { repositoryRoot, worktreeRoot, baseDir } satisfies Fixture;
});

/** The full production layer graph for the dispatch -> worktree path. */
const makeRealStackLayer = (fixture: Fixture) => {
  const settingsLayer = ServerSettings.layerTest({
    automaticWorktreeRoot: fixture.worktreeRoot,
  });
  const configLayer = ServerConfig.layerTest(fixture.repositoryRoot, fixture.baseDir).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const hostLayer = Layer.mergeAll(settingsLayer, configLayer);
  const worktreeStorageLayer = WorktreeStorage.layer.pipe(Layer.provide(hostLayer));
  const vcsProcessLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
  const gitVcsDriverLayer = GitVcsDriver.layer.pipe(
    Layer.provide(worktreeStorageLayer),
    Layer.provide(vcsProcessLayer),
    Layer.provide(NodeServices.layer),
  );
  const vcsRegistryLayer = VcsDriverRegistry.layer.pipe(
    Layer.provide(vcsProcessLayer),
    Layer.provide(NodeServices.layer),
  );
  const gitLayer = gitWorkflowLayer.pipe(
    Layer.provide(vcsRegistryLayer),
    Layer.provide(gitVcsDriverLayer),
    // GitWorkflowService requires the tag at construction; createWorktree and
    // removeWorktree never call it, and this mock dies if that changes.
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(hostLayer),
  );
  return Layer.mergeAll(orchestrationLayer, gitLayer, gitVcsDriverLayer, hostLayer);
};

type RealStackServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | GitWorkflowService
  | GitVcsDriver.GitVcsDriver
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto;

/** Run a real `git` command through the production driver. */
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "WorkerDispatch.e2e.git",
      cwd,
      args,
      timeoutMs: 30_000,
    });
    return result.stdout.trim();
  });

/** A real repository with two commits on a non-default working branch. */
const seedRepository = (repositoryRoot: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd: repositoryRoot });
    yield* git(repositoryRoot, ["config", "user.email", "worker-dispatch-e2e@example.test"]);
    yield* git(repositoryRoot, ["config", "user.name", "Worker Dispatch E2E"]);
    yield* fileSystem.writeFileString(path.join(repositoryRoot, "README.md"), "# e2e\n");
    yield* git(repositoryRoot, ["add", "."]);
    yield* git(repositoryRoot, ["commit", "-m", "initial commit"]);
    yield* git(repositoryRoot, ["checkout", "-b", "feature/orchestrator"]);
    yield* fileSystem.writeFileString(path.join(repositoryRoot, "PLAN.md"), "orchestrator plan\n");
    yield* git(repositoryRoot, ["add", "."]);
    yield* git(repositoryRoot, ["commit", "-m", "orchestrator plan"]);
    return "feature/orchestrator";
  });

/** Create the project and the parent orchestrator thread through real commands. */
const seedOrchestratorThread = (input: {
  readonly repositoryRoot: string;
  readonly branch: string;
}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-e2e-project-create"),
      projectId,
      title: "Workjet dispatch e2e",
      workspaceRoot: input.repositoryRoot,
      defaultModelSelection: modelSelection,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-e2e-parent-create"),
      threadId: parentThreadId,
      projectId,
      title: "Parent orchestrator",
      modelSelection,
      runtimeMode: "auto-accept-edits",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      workjetConfig: {
        schemaVersion: 1,
        role: "orchestrator",
        parent: null,
        managedInstructions: "Keep changes bounded.",
        enabledCapabilityIds: ["greppy", "web-search"],
      },
      branch: input.branch,
      worktreePath: input.repositoryRoot,
      createdAt,
    });
  });

const projectedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    const detail = yield* query.getThreadDetailById(threadId);
    const thread = Option.getOrUndefined(detail);
    assert.isDefined(thread, `thread ${threadId} is missing from the real projection`);
    return thread;
  });

const isWithin = (
  root: string,
  candidate: string,
  path: {
    readonly relative: (from: string, to: string) => string;
    readonly isAbsolute: (value: string) => boolean;
  },
) => {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** HEAD sha, branch and porcelain status of the parent checkout. */
const checkoutState = (cwd: string) =>
  Effect.gen(function* () {
    return {
      head: yield* git(cwd, ["rev-parse", "HEAD"]),
      branch: yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      status: yield* git(cwd, ["status", "--porcelain"]),
    };
  });

const withRealStack = <A, E>(body: (fixture: Fixture) => Effect.Effect<A, E, RealStackServices>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      return yield* body(fixture).pipe(Effect.provide(makeRealStackLayer(fixture)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

it.effect(
  "isolates every dispatched worker in a real worktree beneath the operator-selected root",
  () =>
    withRealStack((fixture) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const branch = yield* seedRepository(fixture.repositoryRoot);
        yield* seedOrchestratorThread({ repositoryRoot: fixture.repositoryRoot, branch });
        const parentBefore = yield* checkoutState(fixture.repositoryRoot);

        const workerDispatch = yield* makeWorkerDispatch();
        const first = yield* workerDispatch.dispatch(invocation, {
          task: "Implement the first bounded slice.",
        });
        const second = yield* workerDispatch.dispatch(invocation, {
          task: "Implement the second bounded slice.",
        });

        const firstThread = yield* projectedThread(first.workerThreadId);
        const secondThread = yield* projectedThread(second.workerThreadId);
        assert.isNotNull(firstThread.worktreePath);
        assert.isNotNull(secondThread.worktreePath);
        const firstPath = firstThread.worktreePath as string;
        const secondPath = secondThread.worktreePath as string;

        // (1) The projected path exists, is a real worktree of the real
        //     repository, and lies beneath the configured storage root.
        for (const workerPath of [firstPath, secondPath]) {
          assert.isTrue(
            yield* fileSystem.exists(workerPath),
            `worker worktree ${workerPath} does not exist on disk`,
          );
          assert.equal(yield* git(workerPath, ["rev-parse", "--is-inside-work-tree"]), "true");
          assert.equal(
            yield* git(workerPath, ["rev-parse", "--show-toplevel"]),
            yield* fileSystem.realPath(workerPath),
          );
          assert.isTrue(
            isWithin(fixture.worktreeRoot, workerPath, path),
            `worker worktree ${workerPath} is not beneath ${fixture.worktreeRoot}`,
          );
        }
        assert.equal(firstThread.branch, `${WORKER_REF_PREFIX}${first.workerThreadId}`);
        assert.equal(secondThread.branch, `${WORKER_REF_PREFIX}${second.workerThreadId}`);
        assert.equal(
          yield* git(firstPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
          `${WORKER_REF_PREFIX}${first.workerThreadId}`,
        );

        // (2) Neither worker shares a checkout with the parent or with the
        //     other worker, and Git itself lists all three.
        assert.notEqual(firstPath, secondPath);
        assert.notEqual(firstPath, fixture.repositoryRoot);
        assert.notEqual(secondPath, fixture.repositoryRoot);
        const worktreeList = yield* git(fixture.repositoryRoot, [
          "worktree",
          "list",
          "--porcelain",
        ]);
        assert.include(worktreeList, fixture.repositoryRoot);
        assert.include(worktreeList, firstPath);
        assert.include(worktreeList, secondPath);

        // Each worker checkout is genuinely independent: a write in one is
        // invisible to the other and to the parent.
        yield* fileSystem.writeFileString(path.join(firstPath, "worker-one.txt"), "one\n");
        assert.isFalse(yield* fileSystem.exists(path.join(secondPath, "worker-one.txt")));
        assert.isFalse(
          yield* fileSystem.exists(path.join(fixture.repositoryRoot, "worker-one.txt")),
        );

        // (3) The parent checkout is untouched.
        const parentAfter = yield* checkoutState(fixture.repositoryRoot);
        assert.deepStrictEqual(parentAfter, parentBefore);
        assert.equal(parentAfter.branch, branch);
        assert.equal(parentAfter.status, "");
      }),
    ),
  { timeout: 120_000 },
);

it.effect(
  "removes the worker worktree when the real engine rejects the worker thread",
  () =>
    withRealStack((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const engine = yield* OrchestrationEngineService;
        const branch = yield* seedRepository(fixture.repositoryRoot);
        yield* seedOrchestratorThread({ repositoryRoot: fixture.repositoryRoot, branch });

        // Force the real decider's `requireThreadAbsent` invariant to reject the
        // worker: an existing thread already owns the id the dispatch will use.
        const collidingThreadId = ThreadId.make("00000000-0000-4000-8000-00000000c011");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-e2e-colliding-create"),
          threadId: collidingThreadId,
          projectId,
          title: "Occupies the worker id",
          modelSelection,
          runtimeMode: "auto-accept-edits",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
          branch: null,
          worktreePath: null,
          createdAt,
        });

        const identifiers = [
          collidingThreadId as string,
          "00000000-0000-4000-8000-00000000c012",
          "00000000-0000-4000-8000-00000000c013",
          "00000000-0000-4000-8000-00000000c014",
        ];
        let index = 0;
        const sources: WorkerDispatchSources = {
          randomUUID: Effect.sync(() => identifiers[index++] ?? "00000000-0000-4000-8000-fallback"),
          nowIso: Effect.succeed(createdAt),
        };
        const workerDispatch = yield* makeWorkerDispatchWithSources(sources);
        const parentBefore = yield* checkoutState(fixture.repositoryRoot);

        const outcome = yield* Effect.exit(
          workerDispatch.dispatch(invocation, { task: "This dispatch must roll back." }),
        );
        assert.equal(outcome._tag, "Failure");

        // The rollback removed the worktree the dispatch had already created:
        // nothing is left under the storage root, and Git no longer lists it.
        const workerRef = `${WORKER_REF_PREFIX}${collidingThreadId}`;
        const remaining = yield* fileSystem.readDirectory(fixture.worktreeRoot).pipe(
          Effect.flatMap((repositoryDirectories) =>
            Effect.forEach(repositoryDirectories, (directory) =>
              fileSystem
                .readDirectory(`${fixture.worktreeRoot}/${directory}`)
                .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>)),
            ),
          ),
          Effect.map((entries) => entries.flat()),
        );
        assert.deepStrictEqual(remaining, []);
        const worktreeList = yield* git(fixture.repositoryRoot, [
          "worktree",
          "list",
          "--porcelain",
        ]);
        assert.notInclude(worktreeList, workerRef.replace(/[^A-Za-z0-9._-]+/g, "-"));

        // `git worktree remove` does not delete the branch, so the rollback
        // deletes the ref explicitly. No dangling `workjet/worker/<uuid>`.
        const remainingRefs = yield* git(fixture.repositoryRoot, [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads/",
        ]);
        assert.notInclude(remainingRefs, workerRef);
        assert.notInclude(remainingRefs, WORKER_REF_PREFIX);

        const parentAfter = yield* checkoutState(fixture.repositoryRoot);
        assert.deepStrictEqual(parentAfter, parentBefore);
      }),
    ),
  { timeout: 120_000 },
);
