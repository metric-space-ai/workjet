/**
 * WorkerWorktreeCleanup - durable removal of a dispatched worker's isolated
 * checkout.
 *
 * `WorkerDispatch` gives every worker thread its own Git worktree plus a
 * throwaway `workjet/worker/<threadId>` branch. Dispatch rollback covers the
 * failure paths only; the durable end of a worker's life is the
 * `thread.deleted` orchestration domain event, which the
 * `ThreadDeletionReactor` already consumes for provider sessions and
 * terminals. This module is the third such cleanup.
 *
 * Safety rules encoded here, in order:
 *  - only threads whose persisted `workjetConfig.role` is `worker`;
 *  - only the exact `worktreePath` recorded on that thread;
 *  - only when that path resolves strictly beneath a trusted automatic
 *    worktree storage root (never the project workspace root, never a root
 *    itself);
 *  - only the branch ref named exactly `workjet/worker/<threadId>`;
 *  - only after the provider confirms the exact local HEAD or retained branch
 *    commit was merged;
 *  - never force worktree removal; branch deletion compares the expected commit.
 *
 * Every outcome is a value, so the reaction is observable, and the caller can
 * log a failure without ever failing the thread deletion it reacts to.
 *
 * @module WorkerWorktreeCleanup
 */
import type { ThreadId } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { WorktreeStorage } from "../worktree/WorktreeStorage.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { WORKER_REF_PREFIX } from "./WorkerDispatch.ts";

/**
 * Why a cleanup did nothing. Skips are normal outcomes, not failures: most
 * deleted threads are not workers at all.
 */
export type WorkerWorktreeCleanupSkipReason =
  | "thread-unavailable"
  | "not-a-worker"
  | "no-worktree-path"
  | "outside-storage-root"
  | "merge-unverified"
  | "already-cleaned";

export type WorkerWorktreeCleanupOutcome =
  | { readonly status: "skipped"; readonly reason: WorkerWorktreeCleanupSkipReason }
  | {
      readonly status: "cleaned";
      readonly worktreePath: string;
      readonly deletedRefName: string;
    };

export type WorkerWorktreeCleanupFailureStep = "read-thread" | "remove-worktree" | "delete-branch";

/**
 * Bounded, redaction-safe failure. Downstream Git and SQL detail is
 * deliberately dropped: this error is logged on a best-effort cleanup path.
 */
export class WorkerWorktreeCleanupError extends Schema.TaggedErrorClass<WorkerWorktreeCleanupError>()(
  "WorkerWorktreeCleanupError",
  {
    step: Schema.Literals(["read-thread", "remove-worktree", "delete-branch"]),
  },
) {
  override get message(): string {
    switch (this.step) {
      case "read-thread":
        return "The deleted thread's worker worktree context could not be read.";
      case "remove-worktree":
        return "The isolated worker worktree could not be removed.";
      case "delete-branch":
        return "The isolated worker branch ref could not be deleted.";
    }
  }
}

export interface WorkerWorktreeCleanupShape {
  /**
   * Idempotent. A missing checkout with an owned branch retries branch cleanup;
   * when both are gone the operation reports an already-cleaned skip.
   */
  readonly cleanupDeletedThread: (
    threadId: ThreadId,
  ) => Effect.Effect<WorkerWorktreeCleanupOutcome, WorkerWorktreeCleanupError>;
}

export class WorkerWorktreeCleanup extends Context.Service<
  WorkerWorktreeCleanup,
  WorkerWorktreeCleanupShape
>()("workjet/workjet/WorkerWorktreeCleanup") {}

/** Strictly beneath `root` — the root itself is never a removal target. */
const isStrictlyWithin = (path: Path.Path, candidate: string, root: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export const make = Effect.fn("WorkerWorktreeCleanup.make")(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const git = yield* GitVcsDriver;
  const sourceControlProviders = yield* SourceControlProviderRegistry;
  const worktreeStorage = yield* WorktreeStorage;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const cleanupDeletedThread: WorkerWorktreeCleanupShape["cleanupDeletedThread"] = Effect.fn(
    "WorkerWorktreeCleanup.cleanupDeletedThread",
  )(function* (threadId) {
    const contextOption = yield* query
      .getThreadWorktreeCleanupContext(threadId)
      .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "read-thread" })));
    const context = Option.getOrUndefined(contextOption);
    if (!context) {
      return { status: "skipped", reason: "thread-unavailable" } as const;
    }
    if (context.workjetRole !== "worker") {
      return { status: "skipped", reason: "not-a-worker" } as const;
    }
    const worktreePath = context.worktreePath;
    if (worktreePath === null || worktreePath.length === 0) {
      return { status: "skipped", reason: "no-worktree-path" } as const;
    }

    // Automatic worker checkouts always live beneath a trusted storage root.
    // Anything else — a hand-attached checkout, the project workspace itself,
    // a path from an older layout — is left untouched.
    const trustedRoots = yield* worktreeStorage.trustedRoots;
    const isAutomatic =
      trustedRoots.some((root) => isStrictlyWithin(path, worktreePath, root)) &&
      !isStrictlyWithin(path, worktreePath, path.resolve(context.workspaceRoot)) &&
      path.resolve(worktreePath) !== path.resolve(context.workspaceRoot);
    if (!isAutomatic) {
      return { status: "skipped", reason: "outside-storage-root" } as const;
    }

    const workerRefName = `${WORKER_REF_PREFIX}${threadId}`;
    if (context.branch !== workerRefName) {
      return { status: "skipped", reason: "merge-unverified" } as const;
    }

    const mergedAtCommit = (cwd: string, commitSha: string) =>
      Effect.gen(function* () {
        const provider = yield* sourceControlProviders.resolve({ cwd });
        const merged = yield* provider.listChangeRequests({
          cwd,
          headSelector: workerRefName,
          state: "merged",
          limit: 100,
        });
        return merged.some(
          (pr) =>
            pr.state === "merged" &&
            pr.headRefName === workerRefName &&
            pr.headCommitOid?.toLowerCase() === commitSha.toLowerCase(),
        );
      }).pipe(Effect.orElseSucceed(() => false));

    const cwd = context.workspaceRoot;
    yield* gitWorkflow.invalidateLocalStatus(worktreePath);
    const local = yield* gitWorkflow
      .localStatus({ cwd: worktreePath })
      .pipe(Effect.orElseSucceed(() => null));
    let verifiedCommitSha: string;
    if (local?.isRepo) {
      if (local.refName !== workerRefName || local.hasWorkingTreeChanges) {
        return { status: "skipped", reason: "merge-unverified" } as const;
      }
      const head = yield* git
        .resolveCommit({ cwd: worktreePath, revision: "HEAD" })
        .pipe(Effect.orElseSucceed(() => null));
      if (!head || !(yield* mergedAtCommit(worktreePath, head.commitSha))) {
        return { status: "skipped", reason: "merge-unverified" } as const;
      }
      verifiedCommitSha = head.commitSha;
      // The project workspace root is the surviving checkout. Never force a
      // dirty worktree removal, even when its HEAD is already merged.
      yield* gitWorkflow
        .removeWorktree({ cwd, path: worktreePath, force: false })
        .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "remove-worktree" })));
    } else {
      // A prior removal may have succeeded while branch deletion failed. If a
      // path still exists but is no longer a Git worktree, retain its files.
      const pathExists = yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
      if (pathExists) return { status: "skipped", reason: "merge-unverified" } as const;
      const branch = yield* git
        .resolveCommit({
          cwd,
          revision: `refs/heads/${workerRefName}`,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (!branch) return { status: "skipped", reason: "already-cleaned" } as const;
      if (!(yield* mergedAtCommit(cwd, branch.commitSha))) {
        return { status: "skipped", reason: "merge-unverified" } as const;
      }
      verifiedCommitSha = branch.commitSha;
    }

    // Git's expected-old-value check refuses deletion if the branch advanced
    // after the provider/head verification. It also works when local HEAD has
    // not fetched the merge yet.
    yield* git
      .deleteBranchAtCommit({ cwd, refName: workerRefName, expectedCommitSha: verifiedCommitSha })
      .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "delete-branch" })));

    return { status: "cleaned", worktreePath, deletedRefName: workerRefName } as const;
  });

  return WorkerWorktreeCleanup.of({ cleanupDeletedThread });
});

export const layer = Layer.effect(WorkerWorktreeCleanup, make());
