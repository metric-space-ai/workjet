import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workjet_worker_supervisor_decisions (
    decision_id TEXT PRIMARY KEY,
    worker_thread_id TEXT NOT NULL,
    supervisor_thread_id TEXT,
    project_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'approval')),
    request_json TEXT NOT NULL,
    answer_json TEXT,
    failure TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answering', 'resolved', 'timed-out')),
    notified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE workjet_worker_owner_engagement (
    thread_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX worker_supervisor_pending ON workjet_worker_supervisor_decisions(worker_thread_id, status)`;
});
