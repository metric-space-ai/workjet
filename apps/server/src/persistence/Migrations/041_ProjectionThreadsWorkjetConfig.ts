import { DEFAULT_WORKJET_THREAD_CONFIG } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "workjet_config_json")) {
    // SQLite does not accept a bound parameter in an ADD COLUMN DEFAULT clause.
    // This value is locally generated from the canonical contract default and
    // escaped as a SQL string literal before the guarded schema change runs.
    const defaultJson = JSON.stringify(DEFAULT_WORKJET_THREAD_CONFIG).replaceAll("'", "''");
    yield* sql.unsafe(`
      ALTER TABLE projection_threads
      ADD COLUMN workjet_config_json TEXT NOT NULL DEFAULT '${defaultJson}'
    `);
  }
});
