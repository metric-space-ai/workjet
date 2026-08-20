import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

const insert = (
  sql: SqlClient.SqlClient,
  overrides: {
    readonly linkId?: string;
    readonly instanceId?: string;
    readonly moduleId?: string;
    readonly objectKind?: string;
    readonly objectId?: string;
    readonly threadId?: string;
  } = {},
) => {
  const objectId = overrides.objectId ?? "deal_4711";
  const threadId = overrides.threadId ?? "thread-1";
  const instanceId = overrides.instanceId ?? "instance-1";
  return sql`
  INSERT INTO workjet_cross_mode_links (
    link_id,
    ctox_instance_id,
    ctox_module_id,
    ctox_object_kind,
    ctox_object_id,
    code_environment_id,
    code_thread_id,
    link_json,
    created_at_ms,
    expires_at_ms
  ) VALUES (
    ${overrides.linkId ?? `wjx-${instanceId}-${objectId}-${threadId}`},
    ${instanceId},
    ${overrides.moduleId ?? "crm"},
    ${overrides.objectKind ?? "deal"},
    ${objectId},
    'environment-1',
    ${threadId},
    '{}',
    10,
    NULL
  )
`;
};

layer("052_WorkjetCrossModeLinks", (it) => {
  it.effect("creates the cross-mode link table only at migration 52", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 51 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'workjet_cross_mode_links'
      `;
      assert.deepEqual([...before], []);

      yield* runMigrations({ toMigrationInclusive: 52 });

      const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
        PRAGMA table_info(workjet_cross_mode_links)
      `;
      assert.deepEqual(columnNames(columns), [
        "code_environment_id",
        "code_thread_id",
        "created_at_ms",
        "ctox_instance_id",
        "ctox_module_id",
        "ctox_object_id",
        "ctox_object_kind",
        "expires_at_ms",
        "link_id",
        "link_json",
      ]);

      // The server-chosen link id is the primary key. A client cannot pin one,
      // so it cannot repoint an existing link by claiming its id.
      assert.deepEqual(
        columns.filter((column) => column.pk > 0).map((column) => column.name),
        ["link_id"],
      );
    }),
  );

  it.effect("makes one Business OS object able to hold at most one link", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });

      yield* insert(sql, { objectId: "deal_a1", threadId: "thread-a1" });

      // The SAME object with a different link id and a different thread: this
      // is exactly the "second Delegate to Code" race, and the database refuses
      // it rather than producing a duplicate Code thread.
      const duplicateObject = yield* insert(sql, {
        objectId: "deal_a1",
        threadId: "thread-a2",
      }).pipe(Effect.result);
      assert.isTrue(duplicateObject._tag === "Failure");

      // A DIFFERENT object on the same instance and module is a distinct link.
      yield* insert(sql, { objectId: "deal_a2", threadId: "thread-a2" });

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM workjet_cross_mode_links WHERE ctox_object_id LIKE 'deal\_a%' ESCAPE '\\'
      `;
      assert.equal(rows[0]?.count, 2);
    }),
  );

  it.effect("makes one Code thread carry at most one backlink", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });

      yield* insert(sql, { objectId: "deal_b1", threadId: "thread-b1" });

      const duplicateThread = yield* insert(sql, {
        objectId: "deal_b2",
        threadId: "thread-b1",
      }).pipe(Effect.result);
      assert.isTrue(duplicateThread._tag === "Failure");
    }),
  );

  it.effect("separates authorities: the same object id on another instance is another link", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });

      yield* insert(sql, { objectId: "deal_c1", threadId: "thread-c1" });
      yield* insert(sql, {
        instanceId: "instance-2",
        objectId: "deal_c1",
        threadId: "thread-c2",
      });

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM workjet_cross_mode_links WHERE ctox_object_id = 'deal_c1'
      `;
      assert.equal(rows[0]?.count, 2);
    }),
  );
});
