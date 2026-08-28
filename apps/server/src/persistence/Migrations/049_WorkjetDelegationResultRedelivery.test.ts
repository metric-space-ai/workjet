import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

layer("049_WorkjetDelegationResultRedelivery", (it) => {
  it.effect("adds the redelivery and reconciliation markers only at migration 49", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 48 });

      const delegationsBefore = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(workjet_delegations)
      `;
      assert.notInclude(columnNames(delegationsBefore), "result_enqueued_at_ms");
      assert.notInclude(columnNames(delegationsBefore), "result_enqueue_failed_at_ms");
      const outboxBefore = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(workjet_mailbox_outbox)
      `;
      assert.notInclude(columnNames(outboxBefore), "reconciled_at_ms");

      yield* runMigrations({ toMigrationInclusive: 49 });

      const delegationsAfter = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`PRAGMA table_info(workjet_delegations)`;
      const outboxAfter = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(workjet_mailbox_outbox)`;

      // All three markers are nullable with no default: NULL is the honest
      // "never happened yet", which is what every pre-existing row means.
      for (const column of [
        delegationsAfter.find((candidate) => candidate.name === "result_enqueued_at_ms"),
        delegationsAfter.find((candidate) => candidate.name === "result_enqueue_failed_at_ms"),
        outboxAfter.find((candidate) => candidate.name === "reconciled_at_ms"),
      ]) {
        assert.isDefined(column);
        assert.strictEqual(column?.notnull, 0);
        assert.strictEqual(column?.dflt_value, null);
      }

      const delegationPrimaryKeys = delegationsAfter
        .filter((column) => column.pk > 0)
        .map((column) => column.name);
      assert.deepEqual(delegationPrimaryKeys, ["delegation_id"]);
    }),
  );

  it.effect("leaves rows pinned before the migration unmarked", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* sql`
        INSERT INTO workjet_delegations
          (delegation_id, delegation_json, state, state_changed_at_ms, terminal, expires_at_ms)
        VALUES ('wjd-pinned-before-redeliv-000', '{}', 'completed', 10, 1, 999)
      `;
      yield* sql`
        INSERT INTO workjet_mailbox_outbox
          (envelope_id, routing_envelope_json, payload_json, state, attempt_count,
           next_attempt_at_ms, created_at_ms, expires_at_ms)
        VALUES ('wjm-pinned-before-redelivery', '{}', '{}', 'dead', 8, 10, 10, 999)
      `;

      yield* runMigrations({ toMigrationInclusive: 49 });

      const delegations = yield* sql<{
        readonly enqueuedAtMillis: number | null;
        readonly failedAtMillis: number | null;
      }>`
        SELECT result_enqueued_at_ms AS "enqueuedAtMillis",
               result_enqueue_failed_at_ms AS "failedAtMillis"
        FROM workjet_delegations
      `;
      assert.deepEqual([...delegations], [{ enqueuedAtMillis: null, failedAtMillis: null }]);

      const outbox = yield* sql<{ readonly reconciledAtMillis: number | null }>`
        SELECT reconciled_at_ms AS "reconciledAtMillis"
        FROM workjet_mailbox_outbox
      `;
      assert.deepEqual([...outbox], [{ reconciledAtMillis: null }]);
    }),
  );
});
