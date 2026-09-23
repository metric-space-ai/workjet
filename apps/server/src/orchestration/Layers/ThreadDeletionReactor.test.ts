import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type WorkjetThreadRole,
} from "@workjet/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { WORKER_REF_PREFIX } from "../../workjet/WorkerDispatch.ts";
import {
  WorkerCleanupReceiptStore,
  type WorkerCleanupReceipt,
  type VerifiedWorkerCleanup,
} from "../../workjet/WorkerCleanupReceiptStore.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
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
    readonly retainedThreadIds?: ReadonlyArray<ThreadId>;
    readonly failRemoveWorktree?: boolean;
    readonly failDeleteBranch?: boolean;
    readonly failDeleteBranchOnce?: boolean;
    readonly failBranchResolveOnce?: boolean;
    readonly failBranchRefLookupOnce?: boolean;
    readonly failMarkCompleteOnce?: boolean;
    readonly failRecordVerified?: boolean;
    readonly initialWorktreePresent?: boolean;
    readonly initialBranchPresent?: boolean;
    readonly advanceBranchAfterDeleteFailure?: boolean;
    readonly failStopProvider?: boolean;
    readonly failArchiveOnce?: boolean;
    readonly failProviderLookup?: boolean;
    readonly failCleanupContextFor?: ThreadId;
    readonly mergeState?: "open" | "closed" | "merged";
    readonly providerHead?: string | null;
    readonly dirty?: boolean;
  }) => {
    const removals: Array<{ readonly cwd: string; readonly path: string }> = [];
    const branchDeletions: Array<{ readonly cwd: string; readonly refName: string }> = [];
    const archives: Array<{ readonly commandId: string; readonly threadId: ThreadId }> = [];
    const archiveAttempts: Array<{ readonly commandId: string; readonly threadId: ThreadId }> = [];
    const archived = new Set<ThreadId>();
    const retryPages: Array<ThreadId | null> = [];
    const providerQueries: Array<{ readonly headSelector: string; readonly state: string }> = [];
    const gitFailure = { _tag: "GitCommandError", detail: "downstream git secret" } as const;
    const commitSha = "a".repeat(40);
    let mergeState = input.mergeState ?? "merged";
    let worktreePresent = input.initialWorktreePresent ?? true;
    let branchPresent = input.initialBranchPresent ?? true;
    let branchCommitSha = commitSha;
    let branchResolveAttempts = 0;
    let branchRefLookupAttempts = 0;
    let completionAttempts = 0;
    const receipts = new Map<ThreadId, WorkerCleanupReceipt>();

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
      dispatch: (command: OrchestrationCommand) =>
        Effect.suspend(() => {
          if (command.type === "thread.archive") {
            const attempt = { commandId: command.commandId, threadId: command.threadId };
            archiveAttempts.push(attempt);
            if (input.failArchiveOnce && archiveAttempts.length === 1) {
              return Effect.fail(new Error("archive dispatch interrupted"));
            }
            archives.push(attempt);
            archived.add(command.threadId);
          }
          return Effect.succeed({ sequence: 1 });
        }),
    } as unknown as OrchestrationEngineService["Service"]);
    const providerLayer = Layer.succeed(ProviderService, {
      stopSession: () =>
        input.failStopProvider ? Effect.fail("provider stop failed") : Effect.void,
    } as unknown as ProviderService["Service"]);
    const terminalLayer = Layer.succeed(TerminalManager.TerminalManager, {
      close: () => Effect.void,
    } as unknown as TerminalManager.TerminalManager["Service"]);
    const queryLayer = Layer.succeed(ProjectionSnapshotQuery, {
      getThreadWorktreeCleanupContext: (threadId: ThreadId) => {
        if (threadId === input.failCleanupContextFor) return Effect.fail("context decode failed");
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
                archivedAt: archived.has(threadId) ? "2026-08-18T00:00:01.000Z" : null,
              }),
        );
      },
      listDeletedWorkerWorktreeCleanupThreadIds: ({
        afterThreadId,
        limit,
      }: {
        readonly afterThreadId: ThreadId | null;
        readonly limit: number;
      }) => {
        retryPages.push(afterThreadId);
        return Effect.succeed(
          (input.retainedThreadIds ?? [])
            .filter((id) => afterThreadId === null || id > afterThreadId)
            .slice(0, limit),
        );
      },
    } as unknown as ProjectionSnapshotQuery["Service"]);
    const gitLayer = Layer.succeed(GitWorkflowService, {
      invalidateLocalStatus: () => Effect.void,
      localStatus: () =>
        Effect.succeed({
          isRepo: worktreePresent,
          refName: workerRefName,
          hasWorkingTreeChanges: input.dirty ?? false,
        }),
      removeWorktree: (removeInput: { readonly cwd: string; readonly path: string }) => {
        removals.push({ cwd: removeInput.cwd, path: removeInput.path });
        if (input.failRemoveWorktree) return Effect.fail(gitFailure);
        worktreePresent = false;
        return Effect.void;
      },
    } as unknown as GitWorkflowService["Service"]);
    const sourceControlLayer = Layer.succeed(SourceControlProviderRegistry, {
      resolve: () =>
        Effect.succeed({
          listChangeRequests: (request: {
            readonly headSelector: string;
            readonly state: string;
          }) => {
            providerQueries.push({ headSelector: request.headSelector, state: request.state });
            return input.failProviderLookup
              ? Effect.fail(gitFailure)
              : Effect.succeed([
                  {
                    state: mergeState,
                    headRefName: workerRefName,
                    url: "https://example.test/pull/7",
                    headCommitOid:
                      input.providerHead === undefined ? commitSha : input.providerHead,
                  },
                ]);
          },
        }),
    } as unknown as SourceControlProviderRegistry["Service"]);
    const gitDriverLayer = Layer.succeed(GitVcsDriver, {
      resolveCommit: (resolveInput: { readonly revision: string }) => {
        if (!resolveInput.revision.startsWith("refs/heads/")) {
          return Effect.succeed({ commitSha });
        }
        branchResolveAttempts += 1;
        return branchPresent && !(input.failBranchResolveOnce && branchResolveAttempts === 1)
          ? Effect.succeed({ commitSha: branchCommitSha })
          : Effect.fail(gitFailure);
      },
      localBranchRefExists: () => {
        branchRefLookupAttempts += 1;
        return input.failBranchRefLookupOnce && branchRefLookupAttempts === 1
          ? Effect.fail(gitFailure)
          : Effect.succeed(branchPresent);
      },
      deleteBranchAtCommit: (deleteInput: {
        readonly cwd: string;
        readonly refName: string;
        readonly expectedCommitSha: string;
      }) => {
        branchDeletions.push({ cwd: deleteInput.cwd, refName: deleteInput.refName });
        if (
          input.failDeleteBranch ||
          (input.failDeleteBranchOnce && branchDeletions.length === 1)
        ) {
          if (input.advanceBranchAfterDeleteFailure) branchCommitSha = "b".repeat(40);
          return Effect.fail(gitFailure);
        }
        if (!branchPresent || deleteInput.expectedCommitSha !== branchCommitSha) {
          return Effect.fail(gitFailure);
        }
        branchPresent = false;
        return Effect.void;
      },
    } as unknown as GitVcsDriver["Service"]);
    const receiptLayer = Layer.succeed(WorkerCleanupReceiptStore, {
      get: (threadId: ThreadId) => Effect.succeed(Option.fromNullishOr(receipts.get(threadId))),
      recordVerified: (receipt: VerifiedWorkerCleanup) => {
        if (input.failRecordVerified)
          return Effect.fail(
            new PersistenceSqlError({
              operation: "WorkerCleanupReceiptStore.recordVerified",
              detail: "database write failed",
            }),
          );
        const existing = receipts.get(receipt.threadId);
        if (existing !== undefined) {
          return Effect.succeed(
            existing.worktreePath === receipt.worktreePath &&
              existing.branchRef === receipt.branchRef &&
              existing.mergedHeadOid === receipt.mergedHeadOid &&
              existing.mergedChangeRequestUrl === receipt.mergedChangeRequestUrl,
          );
        }
        receipts.set(receipt.threadId, { ...receipt, status: "verified" });
        return Effect.succeed(true);
      },
      markComplete: (receipt: VerifiedWorkerCleanup) => {
        completionAttempts += 1;
        if (input.failMarkCompleteOnce && completionAttempts === 1) {
          return Effect.fail(
            new PersistenceSqlError({
              operation: "WorkerCleanupReceiptStore.markComplete",
              detail: "database write interrupted",
            }),
          );
        }
        receipts.set(receipt.threadId, { ...receipt, status: "complete" });
        return Effect.void;
      },
    } as WorkerCleanupReceiptStore["Service"]);

    const reactorLayer = ThreadDeletionReactorLive.pipe(
      Layer.provide(workerWorktreeCleanupLayer),
      Layer.provide(
        Layer.mergeAll(
          engineLayer,
          providerLayer,
          terminalLayer,
          queryLayer,
          gitLayer,
          sourceControlLayer,
          gitDriverLayer,
          receiptLayer,
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

    const reconcile = Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* reactor.reconcileRetainedWorkerWorktrees;
    }).pipe(Effect.scoped, Effect.provide(reactorLayer));

    const reconcileTwoCycles = Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* reactor.reconcileRetainedWorkerWorktrees;
      yield* reactor.reconcileRetainedWorkerWorktrees;
    }).pipe(Effect.scoped, Effect.provide(reactorLayer));

    const reconcileThreeCycles = Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* reactor.reconcileRetainedWorkerWorktrees;
      yield* reactor.reconcileRetainedWorkerWorktrees;
      yield* reactor.reconcileRetainedWorkerWorktrees;
    }).pipe(Effect.scoped, Effect.provide(reactorLayer));

    return {
      removals,
      branchDeletions,
      archives,
      archiveAttempts,
      run,
      reconcile,
      reconcileTwoCycles,
      reconcileThreeCycles,
      retryPages,
      providerQueries,
      receipts,
      setMergeState: (state: "open" | "merged") => {
        mergeState = state;
      },
    };
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
      expect(harness.providerQueries).toEqual([{ headSelector: workerRefName, state: "merged" }]);
      expect(harness.archives).toEqual([
        {
          commandId: `workjet-worker-archive-${workerThreadId}`,
          threadId: workerThreadId,
        },
      ]);
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

  it.effect("retains a checkout attached to a different worker ref", () => {
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
      expect(harness.removals).toEqual([]);
      expect(harness.branchDeletions).toEqual([]);
    });
  });

  it.effect("retains worker source until a matching merged PR head is verified", () =>
    Effect.gen(function* () {
      for (const evidence of [
        { mergeState: "open" as const },
        { mergeState: "closed" as const },
        { providerHead: "b".repeat(40) },
        { providerHead: null },
        { dirty: true },
        { failProviderLookup: true },
      ]) {
        const harness = makeHarness({
          threads: {
            [workerThreadId]: {
              workjetRole: "worker",
              branch: workerRefName,
              worktreePath: workerWorktreePath,
            },
          },
          events: [deletedEvent(workerThreadId)],
          ...evidence,
        });
        yield* harness.run;
        expect(harness.removals).toEqual([]);
        expect(harness.branchDeletions).toEqual([]);
        expect(harness.archives).toEqual([]);
      }
    }),
  );

  it.effect("retains worker source when provider session termination fails", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [deletedEvent(workerThreadId)],
      failStopProvider: true,
    });

    return Effect.gen(function* () {
      yield* harness.run;
      expect(harness.removals).toEqual([]);
      expect(harness.branchDeletions).toEqual([]);
    });
  });

  it.effect("retains both Git sources if merge evidence cannot be persisted", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [deletedEvent(workerThreadId)],
      failRecordVerified: true,
    });

    return Effect.gen(function* () {
      yield* harness.run;
      expect(harness.receipts.size).toBe(0);
      expect(harness.removals).toHaveLength(0);
      expect(harness.branchDeletions).toHaveLength(0);
    });
  });

  it.effect("retries retained source after a later merge and skips it after cleanup", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [],
      retainedThreadIds: [workerThreadId],
      mergeState: "open",
    });

    return Effect.gen(function* () {
      yield* harness.reconcile;
      expect(harness.removals).toEqual([]);
      expect(harness.archives).toEqual([]);
      harness.setMergeState("merged");
      yield* harness.reconcile;
      expect(harness.removals).toEqual([{ cwd: workspaceRoot, path: workerWorktreePath }]);
      expect(harness.archives).toHaveLength(1);
      yield* harness.reconcile;
      expect(harness.removals).toHaveLength(1);
      expect(harness.archives).toHaveLength(1);
    });
  });

  it.effect("retries archival with the same command identity after interrupted dispatch", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [],
      retainedThreadIds: [workerThreadId],
      failArchiveOnce: true,
    });

    return Effect.gen(function* () {
      yield* harness.reconcile;
      expect(harness.receipts.get(workerThreadId)?.status).toBe("complete");
      expect(harness.archives).toEqual([]);
      yield* harness.reconcile;
      expect(harness.archives).toHaveLength(1);
      expect(harness.archiveAttempts).toEqual([
        { commandId: `workjet-worker-archive-${workerThreadId}`, threadId: workerThreadId },
        { commandId: `workjet-worker-archive-${workerThreadId}`, threadId: workerThreadId },
      ]);
    });
  });

  it.effect("continues past an unreadable retained thread", () => {
    const unreadable = ThreadId.make("00000000-0000-4000-8000-000000000001");
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [],
      retainedThreadIds: [unreadable, workerThreadId],
      failCleanupContextFor: unreadable,
    });

    return Effect.gen(function* () {
      yield* harness.reconcile;
      expect(harness.removals).toEqual([{ cwd: workspaceRoot, path: workerWorktreePath }]);
    });
  });

  it.effect("bounds each retry cycle to one page and advances its cursor", () => {
    const earlier = Array.from({ length: 64 }, (_, index) =>
      ThreadId.make(`00000000-0000-4000-7000-${String(index).padStart(12, "0")}`),
    );
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [],
      retainedThreadIds: [...earlier, workerThreadId],
    });

    return Effect.gen(function* () {
      yield* harness.reconcileTwoCycles;
      expect(harness.retryPages).toEqual([null, earlier[63]]);
      expect(harness.removals).toEqual([{ cwd: workspaceRoot, path: workerWorktreePath }]);
    });
  });

  it.effect("recovers branch deletion after worktree removal already succeeded", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [],
      retainedThreadIds: [workerThreadId],
      failDeleteBranchOnce: true,
    });

    return Effect.gen(function* () {
      yield* harness.reconcileThreeCycles;
      expect(harness.removals).toEqual([{ cwd: workspaceRoot, path: workerWorktreePath }]);
      expect(harness.branchDeletions).toEqual([
        { cwd: workspaceRoot, refName: workerRefName },
        { cwd: workspaceRoot, refName: workerRefName },
      ]);
    });
  });

  it.effect("never records cleanup complete when an existing branch cannot be resolved", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [],
      retainedThreadIds: [workerThreadId],
      failDeleteBranchOnce: true,
      failBranchResolveOnce: true,
    });

    return Effect.gen(function* () {
      yield* harness.reconcile;
      expect(harness.receipts.get(workerThreadId)?.status).toBe("verified");
      yield* harness.reconcile;
      expect(harness.receipts.get(workerThreadId)?.status).toBe("verified");
      expect(harness.branchDeletions).toHaveLength(1);
      yield* harness.reconcile;
      expect(harness.receipts.get(workerThreadId)?.status).toBe("complete");
      expect(harness.branchDeletions).toHaveLength(2);
    });
  });

  it.effect("retains a verified receipt when branch-existence lookup fails", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [],
      retainedThreadIds: [workerThreadId],
      failDeleteBranchOnce: true,
      failBranchRefLookupOnce: true,
    });

    return Effect.gen(function* () {
      yield* harness.reconcile;
      yield* harness.reconcile;
      expect(harness.receipts.get(workerThreadId)?.status).toBe("verified");
      expect(harness.branchDeletions).toHaveLength(1);
      yield* harness.reconcile;
      expect(harness.receipts.get(workerThreadId)?.status).toBe("complete");
      expect(harness.branchDeletions).toHaveLength(2);
    });
  });

  it.effect(
    "finishes a verified cleanup after branch deletion but before the completion write",
    () => {
      const harness = makeHarness({
        threads: {
          [workerThreadId]: {
            workjetRole: "worker",
            branch: workerRefName,
            worktreePath: workerWorktreePath,
          },
        },
        events: [],
        retainedThreadIds: [workerThreadId],
        failMarkCompleteOnce: true,
      });

      return Effect.gen(function* () {
        yield* harness.reconcile;
        expect(harness.receipts.get(workerThreadId)?.status).toBe("verified");
        expect(harness.archives).toEqual([]);
        yield* harness.reconcile;
        expect(harness.receipts.get(workerThreadId)?.status).toBe("complete");
        expect(harness.archives).toHaveLength(1);
        expect(harness.removals).toHaveLength(1);
        expect(harness.branchDeletions).toHaveLength(1);
      });
    },
  );

  it.effect("does not infer a completed cleanup from absent source without a receipt", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [deletedEvent(workerThreadId)],
      initialWorktreePresent: false,
      initialBranchPresent: false,
    });

    return Effect.gen(function* () {
      yield* harness.run;
      expect(harness.receipts.size).toBe(0);
      expect(harness.removals).toHaveLength(0);
      expect(harness.branchDeletions).toHaveLength(0);
    });
  });

  it.effect("retains a branch that gained a unique commit after partial cleanup", () => {
    const harness = makeHarness({
      threads: {
        [workerThreadId]: {
          workjetRole: "worker",
          branch: workerRefName,
          worktreePath: workerWorktreePath,
        },
      },
      events: [],
      retainedThreadIds: [workerThreadId],
      failDeleteBranchOnce: true,
      advanceBranchAfterDeleteFailure: true,
    });

    return Effect.gen(function* () {
      yield* harness.reconcileThreeCycles;
      expect(harness.removals).toHaveLength(1);
      expect(harness.branchDeletions).toHaveLength(1);
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
