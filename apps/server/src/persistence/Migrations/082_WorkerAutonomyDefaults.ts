import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** One-time Owner policy; later per-thread choices remain untouched. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_worker_autonomy_migration (
      thread_id TEXT PRIMARY KEY,
      previous_runtime_mode TEXT NOT NULL,
      migrated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `;
  yield* sql`
    INSERT INTO workjet_worker_autonomy_migration (thread_id, previous_runtime_mode)
    SELECT thread_id, runtime_mode FROM projection_threads
    WHERE project_id IN (SELECT project_id FROM projection_projects)
  `;
  yield* sql`UPDATE projection_threads SET runtime_mode = 'full-access'
    WHERE thread_id IN (SELECT thread_id FROM workjet_worker_autonomy_migration)`;
  // Keep the provider's actual mode: the next turn detects the mismatch and restarts it.
  // Historical events must replay the migrated policy, including imported histories.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.runtimeMode', 'full-access')
    WHERE stream_id IN (SELECT thread_id FROM workjet_worker_autonomy_migration)
      AND event_type IN ('thread.created', 'thread.runtime-mode-set')
  `;
});
