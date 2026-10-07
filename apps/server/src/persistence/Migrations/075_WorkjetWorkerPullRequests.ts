// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Native provider observations, never renderer-supplied PR completion claims.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_worker_pull_requests (
      thread_id TEXT PRIMARY KEY,
      worktree_path TEXT NOT NULL,
      branch_ref TEXT NOT NULL,
      provider TEXT NOT NULL,
      pr_number INTEGER NOT NULL CHECK(pr_number > 0),
      pr_url TEXT NOT NULL,
      head_oid TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open', 'merged', 'closed')),
      execution_stopped INTEGER NOT NULL DEFAULT 0 CHECK(execution_stopped IN (0, 1)),
      CHECK(execution_stopped = 0 OR state IN ('merged', 'closed'))
    )
  `;
});
