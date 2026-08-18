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
 *  - only the branch ref named exactly `workjet/worker/<threadId>`.
 *
 * Every outcome is a value, so the reaction is observable, and the caller can
 * log a failure without ever failing the thread deletion it reacts to.
 *
 * @module WorkerWorktreeCleanup
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorktreeStorage } from "../worktree/WorktreeStorage.ts";
import { WORKER_REF_PREFIX } from "./WorkerDispatch.ts";

/**
 * Why a cleanup did nothing. Skips are normal outcomes, not failures: most
 * deleted threads are not workers at all.
 */
export type WorkerWorktreeCleanupSkipReason =
  | "thread-unavailable"
  | "not-a-worker"
  | "no-worktree-path"
  | "outside-storage-root";

export type WorkerWorktreeCleanupOutcome =
  | { readonly status: "skipped"; readonly reason: WorkerWorktreeCleanupSkipReason }
  | {
      readonly status: "cleaned";
      readonly worktreePath: string;
      /** `null` when the thread's branch was not this worker's own ref. */
      readonly deletedRefName: string | null;
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
   * Idempotent. Re-running after a successful cleanup simply reports the
   * removal attempt again; Git failures on already-removed paths surface as a
   * bounded error the caller logs.
   */
  readonly cleanupDeletedThread: (
    threadId: ThreadId,
  ) => Effect.Effect<WorkerWorktreeCleanupOutcome, WorkerWorktreeCleanupError>;
}

export class WorkerWorktreeCleanup extends Context.Service<
  WorkerWorktreeCleanup,
  WorkerWorktreeCleanupShape
>()("t3/workjet/WorkerWorktreeCleanup") {}

/** Strictly beneath `root` — the root itself is never a removal target. */
const isStrictlyWithin = (path: Path.Path, candidate: string, root: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export const make = Effect.fn("WorkerWorktreeCleanup.make")(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const worktreeStorage = yield* WorktreeStorage;
  const path = yield* Path.Path;

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

    // The project workspace root is the one checkout guaranteed not to be the
    // worktree being removed; `git worktree remove` refuses to remove the tree
    // it is executed from.
    const cwd = context.workspaceRoot;
    yield* gitWorkflow
      .removeWorktree({ cwd, path: worktreePath, force: true })
      .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "remove-worktree" })));

    // `git worktree remove` leaves the branch behind. Only this worker's own
    // namespaced ref may be deleted.
    const workerRefName = `${WORKER_REF_PREFIX}${threadId}`;
    if (context.branch !== workerRefName) {
      return { status: "cleaned", worktreePath, deletedRefName: null } as const;
    }
    yield* gitWorkflow
      .deleteBranch({ cwd, refName: workerRefName, force: true })
      .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "delete-branch" })));

    return { status: "cleaned", worktreePath, deletedRefName: workerRefName } as const;
  });

  return WorkerWorktreeCleanup.of({ cleanupDeletedThread });
});

export const layer = Layer.effect(WorkerWorktreeCleanup, make());
