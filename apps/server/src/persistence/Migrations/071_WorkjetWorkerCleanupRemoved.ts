// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Persist native removal separately from branch deletion for safe restart recovery. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_worker_cleanup_receipts_next (
      thread_id TEXT PRIMARY KEY,
      worktree_path TEXT NOT NULL,
      branch_ref TEXT NOT NULL,
      merged_head_oid TEXT NOT NULL,
      merged_change_request_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('verified', 'removed', 'complete')),
      verified_at_ms INTEGER NOT NULL CHECK(verified_at_ms >= 0),
      removed_at_ms INTEGER,
      completed_at_ms INTEGER,
      CHECK(
        (status = 'verified' AND removed_at_ms IS NULL AND completed_at_ms IS NULL)
        OR (status = 'removed' AND removed_at_ms IS NOT NULL AND completed_at_ms IS NULL)
        OR (status = 'complete' AND removed_at_ms IS NOT NULL AND completed_at_ms IS NOT NULL)
      )
    )
  `;
  yield* sql`
    INSERT INTO workjet_worker_cleanup_receipts_next (
      thread_id, worktree_path, branch_ref, merged_head_oid,
      merged_change_request_url, status, verified_at_ms, removed_at_ms, completed_at_ms
    )
    SELECT thread_id, worktree_path, branch_ref, merged_head_oid,
           merged_change_request_url, status, verified_at_ms,
           CASE WHEN status = 'complete' THEN completed_at_ms ELSE NULL END,
           completed_at_ms
    FROM workjet_worker_cleanup_receipts
  `;
  yield* sql`DROP TABLE workjet_worker_cleanup_receipts`;
  yield* sql`ALTER TABLE workjet_worker_cleanup_receipts_next RENAME TO workjet_worker_cleanup_receipts`;
});
