// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

class WorkerCleanupMigrationOrderError extends Schema.TaggedErrorClass<WorkerCleanupMigrationOrderError>()(
  "WorkerCleanupMigrationOrderError",
  { detail: Schema.String },
) {}

/** A verified merge must be durable before removing either local source ref. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // This branch is stacked after the already-applied native CTOX migrations.
  // Refuse an out-of-order install: otherwise a fresh profile could record 64
  // before 59-63 and a later upgrade would skip those native tables.
  const required = [
    "WorkjetCtoxConnectionBindings",
    "WorkjetCtoxNativeRequests",
    "WorkjetCtoxNativeTurns",
    "WorkjetCtoxCrewStarts",
    "WorkjetCtoxCrewProviderBinding",
  ];
  const applied = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
    WHERE migration_id BETWEEN 59 AND 63 ORDER BY migration_id
  `;
  if (
    applied.length !== required.length ||
    applied.some(
      (migration, index) =>
        migration.migration_id !== 59 + index || migration.name !== required[index],
    )
  ) {
    return yield* new WorkerCleanupMigrationOrderError({
      detail: "Project-team migrations require CTOX native migrations 59-63 first.",
    });
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_worker_cleanup_receipts (
      thread_id TEXT PRIMARY KEY,
      worktree_path TEXT NOT NULL,
      branch_ref TEXT NOT NULL,
      merged_head_oid TEXT NOT NULL,
      merged_change_request_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('verified', 'complete')),
      verified_at_ms INTEGER NOT NULL CHECK(verified_at_ms >= 0),
      completed_at_ms INTEGER,
      CHECK((status = 'verified' AND completed_at_ms IS NULL)
        OR (status = 'complete' AND completed_at_ms IS NOT NULL))
    )
  `;
});
