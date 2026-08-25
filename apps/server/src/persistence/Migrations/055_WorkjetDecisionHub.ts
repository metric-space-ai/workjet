import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Decision Hub keeps routing metadata and durable polling state in SQLite.
 * Endpoint and bearer token deliberately do not have columns here; they live
 * together in ServerSecretStore under the connection id.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_decision_hub_connections (
      connection_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('local_ctox', 'ctox_dev')),
      status TEXT NOT NULL CHECK(status IN ('ready', 'needs_auth', 'offline', 'unsupported', 'error')),
      reason TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_decision_hub_escalations (
      decision_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES workjet_decision_hub_connections(connection_id) ON DELETE RESTRICT,
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      decision_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open', 'resolved', 'expired')),
      selected_option_id TEXT,
      comment TEXT,
      resolution_version INTEGER NOT NULL DEFAULT 0,
      next_poll_at_ms INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      continuation_claimed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE(environment_id, thread_id, decision_key)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_decision_hub_escalations_poll
    ON workjet_decision_hub_escalations(status, next_poll_at_ms)
  `;
});
