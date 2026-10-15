import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workjet_meeting_preparations (
    intent_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    supervisor_thread_id TEXT NOT NULL,
    meeting_at TEXT NOT NULL,
    lead_minutes INTEGER NOT NULL,
    configuration_json TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'started', 'completed', 'failed')),
    worker_thread_id TEXT,
    failure TEXT,
    notified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, meeting_at, lead_minutes)
  )`;
});
