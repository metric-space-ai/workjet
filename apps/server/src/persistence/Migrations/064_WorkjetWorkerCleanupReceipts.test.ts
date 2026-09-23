import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("064_WorkjetWorkerCleanupReceipts", (it) => {
  it.effect("refuses project-team migrations on a fresh database that only has migration 58", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });

      const result = yield* Effect.exit(runMigrations({ toMigrationInclusive: 64 }));
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
    }),
  );
});
