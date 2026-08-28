import { DEFAULT_WORKJET_THREAD_CONFIG, WorkjetThreadConfig } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const decodeStoredWorkjetConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(WorkjetThreadConfig),
);

layer("041_ProjectionThreadsWorkjetConfig", (it) => {
  it.effect("adds and backfills the non-null Workjet configuration JSON column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const columnsThrough40 = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info(projection_threads)`;
      assert.isUndefined(columnsThrough40.find((column) => column.name === "workjet_config_json"));

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-before-workjet-config',
          'project-1',
          'Existing thread',
          '{"provider":"codex","model":"gpt-5.4"}',
          NULL,
          NULL,
          NULL,
          '2026-08-14T00:00:00.000Z',
          '2026-08-14T00:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const columnsThrough41 = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
      }>`PRAGMA table_info(projection_threads)`;
      const workjetConfigColumn = columnsThrough41.find(
        (column) => column.name === "workjet_config_json",
      );
      assert.equal(workjetConfigColumn?.name, "workjet_config_json");
      assert.equal(workjetConfigColumn?.type, "TEXT");
      assert.equal(workjetConfigColumn?.notnull, 1);

      const rows = yield* sql<{ readonly workjetConfigJson: string }>`
        SELECT workjet_config_json AS "workjetConfigJson"
        FROM projection_threads
        WHERE thread_id = 'thread-before-workjet-config'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected the pre-existing projection thread row.");
      }

      assert.deepEqual(
        decodeStoredWorkjetConfig(row.workjetConfigJson),
        DEFAULT_WORKJET_THREAD_CONFIG,
      );
    }),
  );
});
