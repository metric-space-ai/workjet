// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_isolated_worker_worktrees (
      worker_id TEXT PRIMARY KEY,
      intent_json TEXT NOT NULL,
      custody_json TEXT,
      destination TEXT NOT NULL UNIQUE
    )
  `;
});
