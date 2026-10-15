import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A submitted PR is terminal for its worker, while the PR itself may remain open. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_worker_pull_requests_submitted (
      thread_id TEXT PRIMARY KEY,
      worktree_path TEXT NOT NULL,
      branch_ref TEXT NOT NULL,
      provider TEXT NOT NULL,
      pr_number INTEGER NOT NULL CHECK(pr_number > 0),
      pr_url TEXT NOT NULL,
      head_oid TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open', 'merged', 'closed')),
      execution_stopped INTEGER NOT NULL DEFAULT 0 CHECK(execution_stopped IN (0, 1))
    )
  `;
  yield* sql`INSERT INTO workjet_worker_pull_requests_submitted SELECT * FROM workjet_worker_pull_requests`;
  yield* sql`DROP TABLE workjet_worker_pull_requests`;
  yield* sql`ALTER TABLE workjet_worker_pull_requests_submitted RENAME TO workjet_worker_pull_requests`;
  yield* sql`
    CREATE TABLE workjet_worker_ordinals (
      environment_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      worker_thread_id TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL CHECK(ordinal > 0),
      UNIQUE(environment_id, parent_thread_id, ordinal)
    )
  `;
  // Team IDs, bindings and instructions remain intact; the role switch no longer grants rights.
  yield* sql`
    UPDATE projection_threads
    SET workjet_config_json = json_set(workjet_config_json, '$.role', 'standard')
    WHERE json_extract(workjet_config_json, '$.schemaVersion') = 2
      AND json_extract(workjet_config_json, '$.role') = 'orchestrator'
      AND json_extract(workjet_config_json, '$.team.role') IN ('supervisor', 'specialist')
  `;
});
