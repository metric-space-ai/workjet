// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Counts one in-place review redrive without extending the signed envelope's expiry. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(workjet_mailbox_outbox)`;
  if (!columns.some((column) => column.name === "review_redrive_count")) {
    yield* sql`
      ALTER TABLE workjet_mailbox_outbox
      ADD COLUMN review_redrive_count INTEGER NOT NULL DEFAULT 0
      CHECK(review_redrive_count >= 0)
    `;
  }
});
