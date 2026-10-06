import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A one-shot marker is written before a recovered provider continuation starts. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workjet_ctox_crew_starts ADD COLUMN recovery_request_id TEXT`;
  yield* sql`ALTER TABLE workjet_ctox_crew_starts ADD COLUMN recovery_reserved_at_ms INTEGER`;
  yield* sql`ALTER TABLE workjet_ctox_crew_starts ADD COLUMN provider_turn_id TEXT`;
  yield* sql`
    CREATE UNIQUE INDEX workjet_ctox_crew_provider_turn_unique
    ON workjet_ctox_crew_starts(thread_id, provider_turn_id)
    WHERE provider_turn_id IS NOT NULL
  `;
});
