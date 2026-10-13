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
      disposition TEXT CHECK(disposition IN ('integrated','abandoned'))
    )
  `;
});
