// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { ThreadId } from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface WorkerCleanupReceipt {
  readonly threadId: ThreadId;
  readonly worktreePath: string;
  readonly branchRef: string;
  readonly mergedHeadOid: string;
  readonly mergedChangeRequestUrl: string;
  readonly status: "verified" | "complete";
}

export type VerifiedWorkerCleanup = Omit<WorkerCleanupReceipt, "status">;

export interface WorkerCleanupReceiptStoreShape {
  readonly get: (threadId: ThreadId) => Effect.Effect<Option.Option<WorkerCleanupReceipt>, unknown>;
  /** Refuses to replace evidence for another path, ref, commit or PR. */
  readonly recordVerified: (receipt: VerifiedWorkerCleanup) => Effect.Effect<boolean, unknown>;
  readonly markComplete: (receipt: VerifiedWorkerCleanup) => Effect.Effect<void, unknown>;
}

export class WorkerCleanupReceiptStore extends Context.Service<
  WorkerCleanupReceiptStore,
  WorkerCleanupReceiptStoreShape
>()("workjet/workjet/WorkerCleanupReceiptStore") {}

const sameEvidence = (a: WorkerCleanupReceipt, b: VerifiedWorkerCleanup): boolean =>
  a.threadId === b.threadId &&
  a.worktreePath === b.worktreePath &&
  a.branchRef === b.branchRef &&
  a.mergedHeadOid === b.mergedHeadOid &&
  a.mergedChangeRequestUrl === b.mergedChangeRequestUrl;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get: WorkerCleanupReceiptStoreShape["get"] = (threadId) =>
    sql<{
      readonly threadId: ThreadId;
      readonly worktreePath: string;
      readonly branchRef: string;
      readonly mergedHeadOid: string;
      readonly mergedChangeRequestUrl: string;
      readonly status: "verified" | "complete";
    }>`
      SELECT thread_id AS "threadId", worktree_path AS "worktreePath",
             branch_ref AS "branchRef", merged_head_oid AS "mergedHeadOid",
             merged_change_request_url AS "mergedChangeRequestUrl", status
      FROM workjet_worker_cleanup_receipts WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const recordVerified: WorkerCleanupReceiptStoreShape["recordVerified"] = (receipt) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO workjet_worker_cleanup_receipts (
          thread_id, worktree_path, branch_ref, merged_head_oid,
          merged_change_request_url, status, verified_at_ms
        ) VALUES (
          ${receipt.threadId}, ${receipt.worktreePath}, ${receipt.branchRef},
          ${receipt.mergedHeadOid}, ${receipt.mergedChangeRequestUrl}, 'verified', ${now}
        ) ON CONFLICT(thread_id) DO NOTHING
      `;
      const recorded = yield* get(receipt.threadId);
      return Option.isSome(recorded) && sameEvidence(recorded.value, receipt);
    });

  const markComplete: WorkerCleanupReceiptStoreShape["markComplete"] = (receipt) =>
    Effect.gen(function* () {
      const recorded = yield* get(receipt.threadId);
      if (Option.isNone(recorded) || !sameEvidence(recorded.value, receipt)) {
        return yield* Effect.fail(new Error("Worker cleanup evidence changed"));
      }
      if (recorded.value.status === "complete") return;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        UPDATE workjet_worker_cleanup_receipts
        SET status = 'complete', completed_at_ms = ${now}
        WHERE thread_id = ${receipt.threadId} AND status = 'verified'
          AND worktree_path = ${receipt.worktreePath}
          AND branch_ref = ${receipt.branchRef}
          AND merged_head_oid = ${receipt.mergedHeadOid}
          AND merged_change_request_url = ${receipt.mergedChangeRequestUrl}
      `;
      const complete = yield* get(receipt.threadId);
      if (Option.isNone(complete) || complete.value.status !== "complete") {
        return yield* Effect.fail(new Error("Worker cleanup completion was not persisted"));
      }
    });

  return WorkerCleanupReceiptStore.of({ get, recordVerified, markComplete });
});

export const layer = Layer.effect(WorkerCleanupReceiptStore, make);
