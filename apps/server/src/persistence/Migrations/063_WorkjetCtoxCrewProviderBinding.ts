import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Add the optional provider-session assignment to existing Crew reservations. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workjet_ctox_crew_starts ADD COLUMN provider_instance_id TEXT`;
  yield* sql`ALTER TABLE workjet_ctox_crew_starts ADD COLUMN provider_thread_id TEXT`;
});
