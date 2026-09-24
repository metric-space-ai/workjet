import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Provider completion is persisted before retryable native result delivery. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE workjet_ctox_crew_starts
    ADD COLUMN provider_terminal_state TEXT
      CHECK (provider_terminal_state IN ('completed', 'failed', 'interrupted', 'cancelled'))
  `;
  yield* sql`ALTER TABLE workjet_ctox_crew_starts ADD COLUMN provider_terminal_at_ms INTEGER`;
  yield* sql`ALTER TABLE workjet_ctox_crew_starts ADD COLUMN provider_reported_at_ms INTEGER`;
  yield* sql`
    CREATE INDEX workjet_ctox_crew_terminal_outbox
    ON workjet_ctox_crew_starts(provider_terminal_at_ms)
    WHERE provider_terminal_state IS NOT NULL AND provider_reported_at_ms IS NULL
  `;
  yield* sql`
    CREATE TABLE workjet_ctox_unbound_provider_terminals (
      thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      terminal_state TEXT NOT NULL
        CHECK (terminal_state IN ('completed', 'failed', 'interrupted', 'cancelled')),
      terminal_at_ms INTEGER NOT NULL,
      PRIMARY KEY (thread_id, provider_instance_id, provider_turn_id)
    )
  `;
  yield* sql`
    CREATE INDEX workjet_ctox_unbound_provider_terminals_age
    ON workjet_ctox_unbound_provider_terminals(terminal_at_ms)
  `;
});
