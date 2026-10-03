import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Persist native intent before sending; CTOX remains the authority for execution state. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_ctox_native_requests (
      thread_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      remote_request_key TEXT NOT NULL UNIQUE,
      connection_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      target_digest TEXT NOT NULL,
      prepared_at_ms INTEGER NOT NULL,
      command_id TEXT,
      task_id TEXT,
      received_at_ms INTEGER,
      PRIMARY KEY (thread_id, request_key)
    )
  `;
});
