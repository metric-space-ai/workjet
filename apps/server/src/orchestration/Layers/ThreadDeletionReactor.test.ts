import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type WorkjetThreadRole,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { WORKER_REF_PREFIX } from "../../workjet/WorkerDispatch.ts";
import { layer as workerWorktreeCleanupLayer } from "../../workjet/WorkerWorktreeCleanup.ts";
import { layerTest as worktreeStorageLayerTest } from "../../worktree/WorktreeStorage.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("worker worktree cleanup on thread.deleted", () => {
  const worktreeRoot = "/Volumes/tmp/workjet/worktrees";
  const workspaceRoot = "/workspace/project";
  const workerThreadId = ThreadId.make("00000000-0000-4000-8000-00000000000a");
  const standardThreadId = ThreadId.make("00000000-0000-4000-8000-00000000000b");
  const workerRefName = `${WORKER_REF_PREFIX}${workerThreadId}`;
  const workerWorktreePath = `${worktreeRoot}/repository-hash/worker-a`;

  interface ThreadFixture {
    readonly workjetRole: WorkjetThreadRole;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }

  const deletedEvent = (threadId: ThreadId) =>
    ({
      type: "thread.deleted",
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-08-18T00:00:00.000Z",
      payload: { threadId, deletedAt: "2026-08-18T00:00:00.000Z" },
    }) as unknown as OrchestrationEvent;

  const makeHarness = (input: {
    readonly threads: Readonly<Record<string, ThreadFixture>>;
    readonly events: ReadonlyArray<OrchestrationEvent>;
    readonly failRemoveWorktree?: boolean;
    readonly failDeleteBranch?: boolean;
  }) => {
    const removals: Array<{ readonly cwd: string; readonly path: string }> = [];
    const branchDeletions: Array<{ readonly cwd: string; readonly refName: string }> = [];
    const gitFailure = { _tag: "GitCommandError", detail: "downstream git secret" } as const;

    // `start()` forks stream consumption, so `drain` alone would race the
    // enqueues. Signalling on stream end makes the test deterministic: every
    // event has been enqueued by then, and `drain` waits for the queue to idle.
    let signalConsumed: () => void = () => {};
    const consumed = new Promise<void>((resolve) => {
      signalConsumed = resolve;
    });
    const engineLayer = Layer.succeed(OrchestrationEngineService, {
      streamDomainEvents: Stream.fromArray(input.events).pipe(
        Stream.onEnd(Effect.sync(() => signalConsumed())),
      ),
    } as unknown as OrchestrationEngineService["Service"]);
    const providerLayer = Layer.succeed(ProviderService, {
      stopSession: () => Effect.void,
    } as unknown as ProviderService["Service"]);
    const terminalLayer = Layer.succeed(TerminalManager.TerminalManager, {
      close: () => Effect.void,
    } as unknown as TerminalManager.TerminalManager["Service"]);
    const queryLayer = Layer.succeed(ProjectionSnapshotQuery, {
      getThreadWorktreeCleanupContext: (threadId: ThreadId) => {
        const fixture = input.threads[threadId];
        return Effect.succeed(
          fixture === undefined
            ? Option.none()
            : Option.some({
                threadId,
                projectId: ProjectId.make("project-1"),
                workspaceRoot,
                workjetRole: fixture.workjetRole,
                branch: fixture.branch,
                worktreePath: fixture.worktreePath,
              }),
        );
      },
    } as unknown as ProjectionSnapshotQuery["Service"]);
    const gitLayer = Layer.succeed(GitWorkflowService, {
      removeWorktree: (removeInput: { readonly cwd: string; readonly path: string }) => {
        removals.push({ cwd: removeInput.cwd, path: removeInput.path });
        return input.failRemoveWorktree ? Effect.fail(gitFailure) : Effect.void;
      },
      deleteBranch: (deleteInput: { readonly cwd: string; readonly refName: string }) => {
        branchDeletions.push({ cwd: deleteInput.cwd, refName: deleteInput.refName });
        return input.failDeleteBranch ? Effect.fail(gitFailure) : Effect.void;
      },
    } as unknown as GitWorkflowService["Service"]);

    const reactorLayer = ThreadDeletionReactorLive.pipe(
      Layer.provide(workerWorktreeCleanupLayer),
      Layer.provide(
        Layer.mergeAll(
          engineLayer,
          providerLayer,
          terminalLayer,
          queryLayer,
          gitLayer,
          worktreeStorageLayerTest({ trustedRoots: [worktreeRoot] }),
          NodeServices.layer,
        ),
      ),
    );

    const run = Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* reactor.start();
      yield* Effect.promise(() => consumed);
      yield* reactor.drain;
    }).pipe(Effect.scoped, Effect.provide(reactorLayer));

    return { removals, branchDeletions, run };
  };

  it.effect("removes the worker worktree and its branch, and leaves other threads alone", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
        [standardThreadId]: {
          workjetRole: "standard",
          branch: "feature/work",
          worktreePath: `${worktreeRoot}/repository-hash/standard-b`,
        },
      },
      events: [deletedEvent(workerThreadId), deletedEvent(standardThreadId)],
    });

    return Effect.gen(function* () {
      yield* harness.run;
      expect(harness.removals).toEqual([{ cwd: workspaceRoot, path: workerWorktreePath }]);
      expect(harness.branchDeletions).toEqual([{ cwd: workspaceRoot, refName: workerRefName }]);
    });
  });

  it.effect("never removes a worktree outside the automatic storage root", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workspaceRoot,
        },
      },
      events: [deletedEvent(workerThreadId)],
    });

    return Effect.gen(function* () {
      yield* harness.run;
      expect(harness.removals).toEqual([]);
      expect(harness.branchDeletions).toEqual([]);
    });
  });

  it.effect("only deletes this thread's own worker ref", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          // A ref the dispatch did not create for this thread id.
          branch: `${WORKER_REF_PREFIX}${standardThreadId}`,
          worktreePath: workerWorktreePath,
        },
      },
      events: [deletedEvent(workerThreadId)],
    });

    return Effect.gen(function* () {
      yield* harness.run;
      expect(harness.removals).toEqual([{ cwd: workspaceRoot, path: workerWorktreePath }]);
      expect(harness.branchDeletions).toEqual([]);
    });
  });

  it.effect("does not fail the deletion reaction when cleanup fails", () =>
    Effect.gen(function* () {
      for (const failure of [{ failRemoveWorktree: true }, { failDeleteBranch: true }] as const) {
        const harness = makeHarness({
          threads: {
            [workerThreadId]: {
              workjetRole: "worker",
              branch: workerRefName,
              worktreePath: workerWorktreePath,
            },
          },
          events: [deletedEvent(workerThreadId)],
          ...failure,
        });

        const exit = yield* Effect.exit(harness.run);

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(harness.removals).toHaveLength(1);
      }
    }),
  );

  it.effect("is idempotent when the same deletion is observed twice", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [deletedEvent(workerThreadId), deletedEvent(workerThreadId)],
      // The second pass finds nothing to remove; git reports that as a failure
      // and the reaction still completes successfully.
      failRemoveWorktree: true,
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(harness.run);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(harness.removals).toEqual([
        { cwd: workspaceRoot, path: workerWorktreePath },
        { cwd: workspaceRoot, path: workerWorktreePath },
      ]);
      // Never a path other than the thread's recorded worktree.
      expect(harness.removals.every(({ path }) => path === workerWorktreePath)).toBe(true);
    });
  });

  it.effect("skips threads whose projection row is already gone", () => {
    const harness = makeHarness({ threads: {}, events: [deletedEvent(workerThreadId)] });

    return Effect.gen(function* () {
      yield* harness.run;
      expect(harness.removals).toEqual([]);
      expect(harness.branchDeletions).toEqual([]);
    });
  });
});
