// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_worker_source_custody (
      worker_id TEXT PRIMARY KEY,
      intent_json TEXT NOT NULL,
      profile_root TEXT NOT NULL UNIQUE,
      profile_json TEXT,
      runtime_json TEXT
    )
  `;
});
