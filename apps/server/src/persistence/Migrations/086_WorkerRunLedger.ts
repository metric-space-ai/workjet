// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_worker_runs (
      run_id TEXT PRIMARY KEY,
      identity_json TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      started_at TEXT,
      first_output_at TEXT,
      terminal_at TEXT,
      abort_class TEXT NOT NULL DEFAULT 'none'
        CHECK(abort_class IN ('auth','quota','transport','timeout','task','none')),
      result_commit TEXT,
      execution_json TEXT,
      disposition TEXT CHECK(disposition IN ('integrated','abandoned'))
    )
  `;
  yield* sql`
    CREATE TABLE workjet_worker_run_assessments (
      run_id TEXT NOT NULL REFERENCES workjet_worker_runs(run_id),
      phase TEXT NOT NULL CHECK(phase IN ('first','final')),
      assessment_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(run_id, phase)
    )
  `;
  yield* sql`
    CREATE TABLE workjet_worker_run_draws (
      brief_sha256 TEXT PRIMARY KEY,
      draw_json TEXT NOT NULL
    )
  `;
});
