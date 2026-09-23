// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A verified merge must be durable before removing either local source ref. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_worker_cleanup_receipts (
      thread_id TEXT PRIMARY KEY,
      worktree_path TEXT NOT NULL,
      branch_ref TEXT NOT NULL,
      merged_head_oid TEXT NOT NULL,
      merged_change_request_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('verified', 'complete')),
      verified_at_ms INTEGER NOT NULL CHECK(verified_at_ms >= 0),
      completed_at_ms INTEGER,
      CHECK((status = 'verified' AND completed_at_ms IS NULL)
        OR (status = 'complete' AND completed_at_ms IS NOT NULL))
    )
  `;
});
