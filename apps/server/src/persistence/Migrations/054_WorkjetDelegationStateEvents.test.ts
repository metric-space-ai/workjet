import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

layer("054_WorkjetDelegationStateEvents", (it) => {
  it.effect("creates the append-only state event log only at migration 54", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 53 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'workjet_delegation_state_events'
      `;
      assert.strictEqual(before.length, 0);

      yield* runMigrations({ toMigrationInclusive: 54 });
      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(workjet_delegation_state_events)
      `;
      assert.deepStrictEqual(columnNames(after), [
        "changed_at_ms",
        "delegation_id",
        "from_state",
        "sequence",
        "terminal",
        "to_state",
      ]);
    }),
  );

  it.effect("records a legal cycle twice instead of collapsing it", () =>
    Effect.gen(function* () {
      // A retry returns a delegation to a state it already held. A unique key
      // on (delegation, from, to) would silently merge the two passes and
      // destroy the retry history this log exists for, so there deliberately
      // is none — this pins that decision.
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });

      for (const changedAt of [10, 20]) {
        yield* sql`
          INSERT INTO workjet_delegation_state_events
            (delegation_id, from_state, to_state, terminal, changed_at_ms)
          VALUES ('delegation-1', 'delivered', 'queued', 0, ${changedAt})
        `;
      }

      const rows = yield* sql<{
        readonly sequence: number;
        readonly changed_at_ms: number;
      }>`
        SELECT sequence, changed_at_ms FROM workjet_delegation_state_events
        WHERE delegation_id = 'delegation-1' ORDER BY sequence ASC
      `;
      assert.strictEqual(rows.length, 2, "both passes of the cycle survive");
      assert.isBelow(rows[0]!.sequence, rows[1]!.sequence);
    }),
  );

  it.effect("orders by sequence, so a clock that steps backwards cannot reorder history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });

      // Second transition carries an EARLIER timestamp than the first.
      yield* sql`
        INSERT INTO workjet_delegation_state_events
          (delegation_id, from_state, to_state, terminal, changed_at_ms)
        VALUES ('delegation-2', 'queued', 'delivered', 0, 500)
      `;
      yield* sql`
        INSERT INTO workjet_delegation_state_events
          (delegation_id, from_state, to_state, terminal, changed_at_ms)
        VALUES ('delegation-2', 'delivered', 'failed', 1, 100)
      `;

      const rows = yield* sql<{ readonly to_state: string }>`
        SELECT to_state FROM workjet_delegation_state_events
        WHERE delegation_id = 'delegation-2' ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.to_state),
        ["delivered", "failed"],
        "insertion order wins over the timestamps",
      );
    }),
  );
});
