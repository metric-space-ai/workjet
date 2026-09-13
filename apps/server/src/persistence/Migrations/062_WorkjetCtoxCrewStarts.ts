import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Local dispatch reservation, not native execution state or a stored capability. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_ctox_crew_starts (
      thread_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      reserved_at_ms INTEGER NOT NULL,
      PRIMARY KEY (thread_id, request_key, attempt_id),
      FOREIGN KEY (thread_id, request_key)
        REFERENCES workjet_ctox_native_requests(thread_id, request_key)
    )
  `;
});
