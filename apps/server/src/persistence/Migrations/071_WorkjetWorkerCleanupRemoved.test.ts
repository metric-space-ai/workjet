// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

describe("071_WorkjetWorkerCleanupRemoved", () => {
  it.effect("preserves verified and completed receipts while adding the removal stage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      for (const [threadId, status, completedAt] of [
        ["verified-worker", "verified", null],
        ["completed-worker", "complete", 200],
      ] as const) {
        yield* sql`
          INSERT INTO workjet_worker_cleanup_receipts
            (thread_id, worktree_path, branch_ref, merged_head_oid,
             merged_change_request_url, status, verified_at_ms, completed_at_ms)
          VALUES (${threadId}, '/safe/worker', 'workjet/worker/example',
                  ${"a".repeat(40)}, 'https://example.test/pull/7', ${status}, 100, ${completedAt})
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 71 });
      const rows = yield* sql<{
        readonly threadId: string;
        readonly status: string;
        readonly removedAt: number | null;
        readonly completedAt: number | null;
      }>`
        SELECT thread_id AS "threadId", status, removed_at_ms AS "removedAt",
               completed_at_ms AS "completedAt"
        FROM workjet_worker_cleanup_receipts ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "completed-worker", status: "complete", removedAt: 200, completedAt: 200 },
        { threadId: "verified-worker", status: "verified", removedAt: null, completedAt: null },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
