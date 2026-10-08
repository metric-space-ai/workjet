// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workjet_remote_worker_receipts (
      direction TEXT NOT NULL CHECK(direction IN ('outbound', 'inbound')),
      request_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT,
      worktree_path TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(direction, request_id),
      CHECK(direction = 'inbound' OR worktree_path IS NULL)
    )
  `;
  yield* sql`
    CREATE INDEX workjet_remote_worker_pending_outbound
    ON workjet_remote_worker_receipts(created_at, request_id)
    WHERE direction = 'outbound' AND response_json IS NULL
  `;
});
