// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type {
  ChangeRequest,
  OrchestrationThread,
  ThreadId,
  WorkjetWorkerPullRequest,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

export interface WorkerPullRequestReceipt {
  readonly threadId: ThreadId;
  readonly worktreePath: string;
  readonly branchRef: string;
  readonly provider: ChangeRequest["provider"];
  readonly prNumber: number;
  readonly prUrl: string;
  readonly headOid: string;
  readonly state: ChangeRequest["state"];
  readonly executionStopped: number;
}

export function sameWorkerPullRequest(
  left: WorkjetWorkerPullRequest,
  right: WorkjetWorkerPullRequest,
): boolean {
  return (
    left.provider === right.provider &&
    left.number === right.number &&
    left.url === right.url &&
    left.branch === right.branch
  );
}

export function receiptMatchesThread(
  receipt: WorkerPullRequestReceipt,
  thread: OrchestrationThread,
): boolean {
  const config = thread.workjetConfig;
  const pr =
    config.schemaVersion === 2 && config.role === "worker" ? config.pullRequest : undefined;
  return (
    config.role === "worker" &&
    receipt.threadId === thread.id &&
    receipt.worktreePath === thread.worktreePath &&
    receipt.branchRef === thread.branch &&
    thread.branch === `workjet/worker/${thread.id}` &&
    pr !== undefined &&
    sameWorkerPullRequest(pr, {
      provider: receipt.provider,
      number: receipt.prNumber,
      url: receipt.prUrl,
      branch: receipt.branchRef,
    })
  );
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = (threadId: ThreadId) =>
    sql<WorkerPullRequestReceipt>`
      SELECT thread_id AS "threadId", worktree_path AS "worktreePath",
        branch_ref AS "branchRef", provider, pr_number AS "prNumber", pr_url AS "prUrl",
        head_oid AS "headOid", state, execution_stopped AS "executionStopped"
      FROM workjet_worker_pull_requests WHERE thread_id = ${threadId}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("WorkerPullRequestStore.get")),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );
  // Called only with a matching native Git/provider observation. First PR is immutable.
  const observe = (receipt: Omit<WorkerPullRequestReceipt, "executionStopped">) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
        INSERT INTO workjet_worker_pull_requests
          (thread_id, worktree_path, branch_ref, provider, pr_number, pr_url, head_oid, state)
        VALUES (${receipt.threadId}, ${receipt.worktreePath}, ${receipt.branchRef},
          ${receipt.provider}, ${receipt.prNumber}, ${receipt.prUrl}, ${receipt.headOid}, ${receipt.state})
        ON CONFLICT(thread_id) DO NOTHING
      `;
          const previous = yield* get(receipt.threadId);
          if (Option.isNone(previous)) return false;
          const bound = previous.value;
          if (
            bound.worktreePath !== receipt.worktreePath ||
            bound.branchRef !== receipt.branchRef ||
            bound.provider !== receipt.provider ||
            bound.prNumber !== receipt.prNumber ||
            bound.prUrl !== receipt.prUrl
          )
            return false;
          // A terminal run cannot reopen or move to another outcome.
          if (bound.state !== "open")
            return bound.state === receipt.state && bound.headOid === receipt.headOid;
          yield* sql`
        UPDATE workjet_worker_pull_requests SET head_oid = ${receipt.headOid}, state = ${receipt.state}
        WHERE thread_id = ${receipt.threadId} AND state = 'open'
      `;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("WorkerPullRequestStore.observe")));
  const markExecutionStopped = (threadId: ThreadId) =>
    sql`
      UPDATE workjet_worker_pull_requests SET execution_stopped = 1
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("WorkerPullRequestStore.markExecutionStopped")),
      Effect.asVoid,
    );
  return { get, observe, markExecutionStopped };
});

export class WorkerPullRequestStore extends Context.Service<
  WorkerPullRequestStore,
  Effect.Success<typeof make>
>()("workjet/workjet/WorkerPullRequestStore") {}
export const layer = Layer.effect(WorkerPullRequestStore, make);
