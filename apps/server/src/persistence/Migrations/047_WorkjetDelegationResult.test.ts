import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

layer("047_WorkjetDelegationResult", (it) => {
  it.effect("adds the nullable result_json column only at migration 47", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // 45 and 46 are reserved for sibling agents and absent here, so migrating
      // "through 46" lands the delegations table at its 042 shape.
      yield* runMigrations({ toMigrationInclusive: 46 });

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(workjet_delegations)
      `;
      assert.notInclude(columnNames(before), "result_json");

      yield* runMigrations({ toMigrationInclusive: 47 });

      const after = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`PRAGMA table_info(workjet_delegations)`;

      assert.include(columnNames(after), "result_json");

      const added = after.find((column) => column.name === "result_json");
      assert.isDefined(added);
      // Nullable and without a default: NULL is the honest "not finalized yet".
      assert.strictEqual(added?.notnull, 0);
      assert.strictEqual(added?.dflt_value, null);
      assert.strictEqual(added?.pk, 0, "the primary key stays the delegation id alone");
    }),
  );

  it.effect("preserves delegation rows pinned before the column existed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`
        INSERT INTO workjet_delegations
          (delegation_id, delegation_json, state, state_changed_at_ms, terminal, expires_at_ms)
        VALUES ('wjd-pinned-before-result-0000', '{}', 'running', 10, 0, 999)
      `;

      // ADD COLUMN must not rewrite or drop the delegation body pinned by 042.
      yield* runMigrations({ toMigrationInclusive: 47 });

      const rows = yield* sql<{
        readonly delegationId: string;
        readonly state: string;
        readonly resultJson: string | null;
      }>`
        SELECT delegation_id AS "delegationId",
               state AS "state",
               result_json AS "resultJson"
        FROM workjet_delegations
      `;
      assert.deepEqual(
        [...rows],
        [{ delegationId: "wjd-pinned-before-result-0000", state: "running", resultJson: null }],
      );
    }),
  );
});
