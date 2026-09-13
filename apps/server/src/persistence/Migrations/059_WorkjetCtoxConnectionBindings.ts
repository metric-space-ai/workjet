import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A connection id keeps its instance even after credentials and its UI row are removed. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_ctox_connection_bindings (
      connection_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO workjet_ctox_connection_bindings (connection_id, instance_id, created_at_ms)
    SELECT connection_id, instance_id, created_at_ms FROM workjet_decision_hub_connections
  `;
});
