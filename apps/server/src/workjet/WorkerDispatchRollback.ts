import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  NativeWorkerWorktreeRemover,
  type CapturedWorkerWorktree,
} from "./NativeWorkerWorktreeRemover.ts";

export class WorkerDispatchRollbackError extends Schema.TaggedErrorClass<WorkerDispatchRollbackError>()(
  "WorkerDispatchRollbackError",
  {
    reason: Schema.Literals(["changed", "unavailable"]),
    recoveryWorktreePath: Schema.optional(Schema.String),
    recoveryAdminPath: Schema.optional(Schema.String),
    originalWorktreePath: Schema.optional(Schema.String),
    originalAdminPath: Schema.optional(Schema.String),
    recoveryLocationStatus: Schema.optional(Schema.Literals(["candidate", "verified"])),
  },
) {}

export interface WorkerDispatchRecovery {
  readonly recoveryWorktreePath: string;
  readonly recoveryAdminPath: string;
  readonly originalWorktreePath: string;
  readonly originalAdminPath: string;
  readonly recoveryLocationStatus: "candidate" | "verified";
}

export class WorkerDispatchRollback extends Context.Service<
  WorkerDispatchRollback,
  {
    /** Capture before dispatch. The returned effect requires a rejected command receipt. */
    readonly prepare: (input: {
      readonly cwd: string;
      readonly worktreePath: string;
      readonly branchRef: string;
      readonly custody?: CapturedWorkerWorktree;
    }) => Effect.Effect<
      Effect.Effect<WorkerDispatchRecovery, WorkerDispatchRollbackError>,
      WorkerDispatchRollbackError
    >;
  }
>()("workjet/workjet/WorkerDispatchRollback") {}

export const make = Effect.fn("WorkerDispatchRollback.make")(function* () {
  const git = yield* GitVcsDriver;
  const remover = yield* NativeWorkerWorktreeRemover;
  const unavailable = () => new WorkerDispatchRollbackError({ reason: "unavailable" });
  const changed = () => new WorkerDispatchRollbackError({ reason: "changed" });

  const prepare: WorkerDispatchRollback["Service"]["prepare"] = Effect.fn(
    "WorkerDispatchRollback.prepare",
  )(function* (input) {
    if (input.custody !== undefined && input.custody.worktreePath !== input.worktreePath)
      return yield* changed();
    const captured =
      input.custody ??
      (yield* remover.capture(input.worktreePath).pipe(Effect.mapError(unavailable)));
    const head = yield* git
      .resolveCommit({ cwd: input.worktreePath, revision: "HEAD" })
      .pipe(Effect.mapError(unavailable));

    const verifyCheckout = Effect.gen(function* () {
      const current = yield* remover
        .capture(input.worktreePath, captured.kind)
        .pipe(Effect.mapError(unavailable));
      if (
        current.kind !== captured.kind ||
        current.worktreeDev !== captured.worktreeDev ||
        current.worktreeIno !== captured.worktreeIno ||
        current.adminPath !== captured.adminPath ||
        current.adminDev !== captured.adminDev ||
        current.adminIno !== captured.adminIno
      )
        return yield* changed();
      const currentHead = yield* git
        .resolveCommit({ cwd: input.worktreePath, revision: "HEAD" })
        .pipe(Effect.mapError(unavailable));
      if (currentHead.commitSha !== head.commitSha) return yield* changed();
      const branch = yield* git
        .execute({
          operation: "WorkerDispatchRollback.branch",
          cwd: input.worktreePath,
          args: ["symbolic-ref", "HEAD"],
        })
        .pipe(Effect.mapError(unavailable));
      const status = yield* git
        .execute({
          operation: "WorkerDispatchRollback.status",
          cwd: input.worktreePath,
          args: ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"],
        })
        .pipe(Effect.mapError(unavailable));
      if (
        branch.stdoutTruncated ||
        status.stdoutTruncated ||
        branch.stdout.trim() !== `refs/heads/${input.branchRef}` ||
        status.stdout !== ""
      )
        return yield* changed();
    });
    yield* verifyCheckout;

    return Effect.gen(function* () {
      yield* verifyCheckout;
      // Never recursively delete an unstarted checkout: a late editor write
      // can race any clean-status check without changing the directory inode.
      const recovery = yield* remover
        .quarantineCaptured(captured, {
          headOid: head.commitSha,
          branchRef: input.branchRef,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new WorkerDispatchRollbackError({
                reason: "unavailable",
                ...(error.originalWorktreePath
                  ? { originalWorktreePath: error.originalWorktreePath }
                  : {}),
                ...(error.originalAdminPath ? { originalAdminPath: error.originalAdminPath } : {}),
                ...(error.recoveryLocationStatus
                  ? { recoveryLocationStatus: error.recoveryLocationStatus }
                  : {}),
                ...(error.recoveryWorktreePath
                  ? { recoveryWorktreePath: error.recoveryWorktreePath }
                  : {}),
                ...(error.recoveryAdminPath ? { recoveryAdminPath: error.recoveryAdminPath } : {}),
              }),
          ),
        );
      // An isolated checkout owns its ref in the quarantined .git directory.
      // There is no branch to remove from the source project's repository.
      if (captured.kind !== "isolated")
        yield* git
          .deleteBranchAtCommit({
            cwd: input.cwd,
            refName: input.branchRef,
            expectedCommitSha: head.commitSha,
          })
          .pipe(
            Effect.mapError(
              () => new WorkerDispatchRollbackError({ reason: "unavailable", ...recovery }),
            ),
          );
      return recovery;
    });
  });

  return WorkerDispatchRollback.of({ prepare });
});

export const layer = Layer.effect(WorkerDispatchRollback, make());
