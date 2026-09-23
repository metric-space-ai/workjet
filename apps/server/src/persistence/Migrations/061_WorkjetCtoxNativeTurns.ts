import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Native Dev turns are distinct from external MCP delegations in the same thread. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_ctox_native_turns (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      UNIQUE (thread_id, request_id),
      UNIQUE (thread_id, request_key),
      FOREIGN KEY (thread_id, request_key)
        REFERENCES workjet_ctox_native_requests(thread_id, request_key)
    )
  `;
  yield* sql`CREATE INDEX workjet_ctox_native_turns_thread ON workjet_ctox_native_turns(thread_id, sequence)`;
});
