import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("refreshes cached result columns when a migration rebuilds a table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE rebuilt_entries(id TEXT, name TEXT, deleted_at TEXT)`;
      yield* sql`INSERT INTO rebuilt_entries VALUES ('one', 'Preserved', NULL)`;
      const before = yield* sql`SELECT * FROM rebuilt_entries`;
      assert.deepEqual(before, [{ id: "one", name: "Preserved", deleted_at: null }]);
      yield* sql`
        CREATE TABLE rebuilt_entries_next(id TEXT, registration TEXT, name TEXT, deleted_at TEXT)
      `;
      yield* sql`
        INSERT INTO rebuilt_entries_next SELECT id, NULL, name, deleted_at FROM rebuilt_entries
      `;
      yield* sql`DROP TABLE rebuilt_entries`;
      yield* sql`ALTER TABLE rebuilt_entries_next RENAME TO rebuilt_entries`;
      const after = yield* sql`SELECT * FROM rebuilt_entries`;
      assert.deepEqual(after, [
        { id: "one", registration: null, name: "Preserved", deleted_at: null },
      ]);
      const values = yield* sql`SELECT * FROM rebuilt_entries`.values;
      assert.deepEqual(values, [["one", null, "Preserved", null]]);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );
});

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);
