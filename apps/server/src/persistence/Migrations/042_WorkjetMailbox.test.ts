import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const tableNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

layer("042_WorkjetMailbox", (it) => {
  it.effect("creates the durable Workjet mailbox tables and their access indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name AS "name"
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('workjet_mailbox_outbox', 'workjet_mailbox_inbox', 'workjet_delegations')
      `;
      assert.deepEqual(tableNames(before), []);

      yield* runMigrations({ toMigrationInclusive: 42 });

      const after = yield* sql<{ readonly name: string }>`
        SELECT name AS "name"
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('workjet_mailbox_outbox', 'workjet_mailbox_inbox', 'workjet_delegations')
      `;
      assert.deepEqual(tableNames(after), [
        "workjet_delegations",
        "workjet_mailbox_inbox",
        "workjet_mailbox_outbox",
      ]);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name AS "name"
        FROM sqlite_master
        WHERE type = 'index'
          AND name LIKE 'idx_workjet_%'
      `;
      assert.deepEqual(tableNames(indexes), [
        "idx_workjet_delegations_expiry",
        "idx_workjet_delegations_state",
        "idx_workjet_mailbox_inbox_expiry",
        "idx_workjet_mailbox_inbox_unprocessed",
        "idx_workjet_mailbox_outbox_expiry",
        "idx_workjet_mailbox_outbox_pending",
      ]);
    }),
  );

  it.effect("declares the outbox envelope id as the primary key with a checked state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const columns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(workjet_mailbox_outbox)`;

      const envelopeId = columns.find((column) => column.name === "envelope_id");
      assert.equal(envelopeId?.pk, 1);
      assert.equal(envelopeId?.type, "TEXT");

      const attemptCount = columns.find((column) => column.name === "attempt_count");
      assert.equal(attemptCount?.type, "INTEGER");
      assert.equal(attemptCount?.notnull, 1);

      const deliveredAt = columns.find((column) => column.name === "delivered_at_ms");
      assert.equal(deliveredAt?.notnull, 0);

      const rejected = yield* sql`
        INSERT INTO workjet_mailbox_outbox (
          envelope_id, routing_envelope_json, payload_json, state,
          attempt_count, next_attempt_at_ms, created_at_ms, expires_at_ms
        )
        VALUES ('envelope-with-bad-state', '{}', '{}', 'nonsense', 0, 0, 0, 0)
      `.pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
    }),
  );

  it.effect("declares the inbox and delegation primary keys", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const inboxColumns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(workjet_mailbox_inbox)`;
      assert.equal(inboxColumns.find((column) => column.name === "envelope_id")?.pk, 1);
      assert.equal(inboxColumns.find((column) => column.name === "processed_at_ms")?.notnull, 0);
      assert.equal(inboxColumns.find((column) => column.name === "received_at_ms")?.notnull, 1);

      const delegationColumns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(workjet_delegations)`;
      assert.equal(delegationColumns.find((column) => column.name === "delegation_id")?.pk, 1);
      assert.equal(delegationColumns.find((column) => column.name === "terminal")?.notnull, 1);
      assert.equal(delegationColumns.find((column) => column.name === "state")?.notnull, 1);
    }),
  );

  it.effect("is idempotent when the migration set is applied twice", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 42 });
      const second = yield* runMigrations({ toMigrationInclusive: 42 });
      assert.deepEqual(second, []);
    }),
  );
});
