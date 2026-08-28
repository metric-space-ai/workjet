import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

layer("045_WorkjetDelegationEdges", (it) => {
  it.effect("creates the delegation-graph edge table only at migration 45", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'workjet_delegation_edges'
      `;
      assert.deepEqual([...before], []);

      yield* runMigrations({ toMigrationInclusive: 45 });

      const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
        PRAGMA table_info(workjet_delegation_edges)
      `;
      assert.deepEqual(columnNames(columns), [
        "created_at_ms",
        "depth",
        "edge_id",
        "edge_json",
        "from_delegation_id",
        "kind",
        "to_delegation_id",
      ]);

      // The stable edge id is the primary key: that is what makes edge
      // insertion idempotent under at-least-once transport.
      assert.deepEqual(
        columns.filter((column) => column.pk > 0).map((column) => column.name),
        ["edge_id"],
      );
    }),
  );

  it.effect("enforces the kind CHECK and the idempotent primary key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });

      // A kind outside the typed edge set is refused at the schema level.
      const badKind = yield* sql`
        INSERT INTO workjet_delegation_edges
          (edge_id, kind, from_delegation_id, to_delegation_id, edge_json, depth, created_at_ms)
        VALUES ('edge-1', 'depends-on', 'del-a', 'del-b', '{}', 0, 10)
      `.pipe(Effect.result);
      assert.isTrue(badKind._tag === "Failure");

      yield* sql`
        INSERT INTO workjet_delegation_edges
          (edge_id, kind, from_delegation_id, to_delegation_id, edge_json, depth, created_at_ms)
        VALUES ('edge-1', 'reviews', 'del-a', 'del-b', '{}', 0, 10)
      `;

      // Re-inserting the identical edge id conflicts: the row cannot duplicate.
      const conflict = yield* sql`
        INSERT INTO workjet_delegation_edges
          (edge_id, kind, from_delegation_id, to_delegation_id, edge_json, depth, created_at_ms)
        VALUES ('edge-1', 'revises', 'del-a', 'del-b', '{}', 1, 20)
      `.pipe(Effect.result);
      assert.isTrue(conflict._tag === "Failure");

      const rows = yield* sql<{ readonly kind: string }>`
        SELECT kind FROM workjet_delegation_edges
      `;
      assert.deepEqual(
        rows.map((row) => row.kind),
        ["reviews"],
      );
    }),
  );
});
