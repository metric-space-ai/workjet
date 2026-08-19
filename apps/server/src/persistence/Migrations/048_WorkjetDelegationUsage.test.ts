import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

layer("048_WorkjetDelegationUsage", (it) => {
  it.effect("adds the usage/approval columns only at migration 48", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(workjet_delegations)
      `;
      assert.notInclude(columnNames(before), "usage_tokens");
      assert.notInclude(columnNames(before), "usage_cost_micros");
      assert.notInclude(columnNames(before), "approval_state");

      yield* runMigrations({ toMigrationInclusive: 48 });

      const after = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`PRAGMA table_info(workjet_delegations)`;

      const names = columnNames(after);
      assert.include(names, "usage_tokens");
      assert.include(names, "usage_cost_micros");
      assert.include(names, "approval_state");

      const tokens = after.find((column) => column.name === "usage_tokens");
      assert.strictEqual(tokens?.notnull, 1);
      assert.strictEqual(tokens?.dflt_value, "0");

      const cost = after.find((column) => column.name === "usage_cost_micros");
      assert.strictEqual(cost?.notnull, 1);
      assert.strictEqual(cost?.dflt_value, "0");

      const approval = after.find((column) => column.name === "approval_state");
      assert.strictEqual(approval?.notnull, 1);
      // SQLite stores the string default literally, quotes included.
      assert.strictEqual(approval?.dflt_value, "'not-required'");
      assert.strictEqual(approval?.pk, 0, "the primary key stays the delegation id alone");
    }),
  );

  it.effect("backfills existing rows with zero usage and no approval requirement", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO workjet_delegations
          (delegation_id, delegation_json, state, state_changed_at_ms, terminal, expires_at_ms)
        VALUES ('wjd-pinned-before-usage-00000', '{}', 'running', 10, 0, 999)
      `;

      yield* runMigrations({ toMigrationInclusive: 48 });

      const rows = yield* sql<{
        readonly delegationId: string;
        readonly usageTokens: number;
        readonly usageCostMicros: number;
        readonly approvalState: string;
      }>`
        SELECT delegation_id AS "delegationId",
               usage_tokens AS "usageTokens",
               usage_cost_micros AS "usageCostMicros",
               approval_state AS "approvalState"
        FROM workjet_delegations
      `;
      assert.deepEqual(
        [...rows],
        [
          {
            delegationId: "wjd-pinned-before-usage-00000",
            usageTokens: 0,
            usageCostMicros: 0,
            approvalState: "not-required",
          },
        ],
      );
    }),
  );
});
