import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0064 from "./064_WorkjetWorkerCleanupReceipts.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("064_WorkjetWorkerCleanupReceipts", (it) => {
  it.effect("applies native CTOX and project-team migrations in order on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });

      const applied = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id BETWEEN 59 AND 66 ORDER BY migration_id
      `;
      assert.deepStrictEqual(applied, [
        { migration_id: 59, name: "WorkjetCtoxConnectionBindings" },
        { migration_id: 60, name: "WorkjetCtoxNativeRequests" },
        { migration_id: 61, name: "WorkjetCtoxNativeTurns" },
        { migration_id: 62, name: "WorkjetCtoxCrewStarts" },
        { migration_id: 63, name: "WorkjetCtoxCrewProviderBinding" },
        { migration_id: 64, name: "WorkjetWorkerCleanupReceipts" },
        { migration_id: 65, name: "WorkjetMailboxReviewRedrive" },
        { migration_id: 66, name: "WorkjetProjectTeamLearning" },
      ]);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
          AND name IN ('workjet_ctox_native_requests', 'workjet_worker_cleanup_receipts', 'workjet_team_reviews')
        ORDER BY name
      `;
      assert.deepStrictEqual(tables, [
        { name: "workjet_ctox_native_requests" },
        { name: "workjet_team_reviews" },
        { name: "workjet_worker_cleanup_receipts" },
      ]);
    }),
  );

  it.effect("refuses direct project-team migration before native CTOX migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });

      const result = yield* Effect.exit(Migration0064);
      assert.equal(result._tag, "Failure");
      const applied = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 64
      `;
      assert.deepStrictEqual(applied, []);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workjet_worker_cleanup_receipts'
      `;
      assert.deepStrictEqual(tables, []);
    }),
  );

  it.effect("accepts the exact applied native CTOX 59-63 migration history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      for (const [id, name] of [
        [59, "WorkjetCtoxConnectionBindings"],
        [60, "WorkjetCtoxNativeRequests"],
        [61, "WorkjetCtoxNativeTurns"],
        [62, "WorkjetCtoxCrewStarts"],
        [63, "WorkjetCtoxCrewProviderBinding"],
      ] as const) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 64 });
      const applied = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 64
      `;
      assert.deepStrictEqual(applied, [{ migration_id: 64, name: "WorkjetWorkerCleanupReceipts" }]);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workjet_worker_cleanup_receipts'
      `;
      assert.deepStrictEqual(tables, [{ name: "workjet_worker_cleanup_receipts" }]);
    }),
  );

  it.effect("refuses a reused native migration ID with a different name", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      for (const [id, name] of [
        [59, "WorkjetCtoxConnectionBindings"],
        [60, "WorkjetCtoxNativeRequests"],
        [61, "WorkjetWorkerCleanupReceipts"],
        [62, "WorkjetCtoxCrewStarts"],
        [63, "WorkjetCtoxCrewProviderBinding"],
      ] as const) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})
        `;
      }

      const result = yield* Effect.exit(runMigrations({ toMigrationInclusive: 64 }));
      assert.equal(result._tag, "Failure");
      const applied = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 64
      `;
      assert.deepStrictEqual(applied, []);
    }),
  );
});
