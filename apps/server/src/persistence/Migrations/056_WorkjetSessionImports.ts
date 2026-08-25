import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_session_imports (
      source_key TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      imported_message_count INTEGER NOT NULL,
      prefix_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_session_imports_thread_id
    ON workjet_session_imports(thread_id)
  `;
});
