import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { NativeWorkerWorktreeRemover } from "./NativeWorkerWorktreeRemover.ts";

export class WorkerDispatchRollbackError extends Schema.TaggedErrorClass<WorkerDispatchRollbackError>()(
  "WorkerDispatchRollbackError",
  { reason: Schema.Literals(["changed", "unavailable"]) },
) {}

export class WorkerDispatchRollback extends Context.Service<
  WorkerDispatchRollback,
  {
    /** Capture before dispatch. The returned effect requires a rejected command receipt. */
    readonly prepare: (input: {
      readonly cwd: string;
      readonly worktreePath: string;
      readonly branchRef: string;
    }) => Effect.Effect<
      Effect.Effect<void, WorkerDispatchRollbackError>,
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
    const captured = yield* remover.capture(input.worktreePath).pipe(Effect.mapError(unavailable));
    const head = yield* git
      .resolveCommit({ cwd: input.worktreePath, revision: "HEAD" })
      .pipe(Effect.mapError(unavailable));

    const verifyCheckout = Effect.gen(function* () {
      const current = yield* remover.capture(input.worktreePath).pipe(Effect.mapError(unavailable));
      if (
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
      // Use the identities saved before thread creation, never fresh identities
      // from a mutable pathname after a rejection. The native helper pins both
      // directories and checks backlinks without following symlinks.
      yield* remover.removeCaptured(captured).pipe(Effect.mapError(unavailable));
      yield* git
        .deleteBranchAtCommit({
          cwd: input.cwd,
          refName: input.branchRef,
          expectedCommitSha: head.commitSha,
        })
        .pipe(Effect.mapError(unavailable));
    });
  });

  return WorkerDispatchRollback.of({ prepare });
});

export const layer = Layer.effect(WorkerDispatchRollback, make());
