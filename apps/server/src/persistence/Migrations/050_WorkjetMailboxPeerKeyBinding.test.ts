import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

layer("050_WorkjetMailboxPeerKeyBinding", (it) => {
  it.effect("adds the peer key-binding column only at migration 50", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 49 });

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(workjet_mailbox_peer_keys)
      `;
      assert.notInclude(columnNames(before), "key_binding");

      yield* runMigrations({ toMigrationInclusive: 50 });

      const after = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`PRAGMA table_info(workjet_mailbox_peer_keys)`;

      assert.deepEqual(columnNames(after), [
        "encryption_public_key",
        "first_seen_at_ms",
        "key_binding",
        "public_key",
        "source_environment_id",
        "source_workspace_id",
      ]);

      const added = after.find((column) => column.name === "key_binding");
      assert.isDefined(added);
      // NOT NULL with a constant default, deliberately. Every pre-050 row was
      // established without a binding, and `'tofu'` states that honestly; a
      // nullable column would leave an "unknown" level that the downgrade check
      // would then have to guess at.
      assert.strictEqual(added?.notnull, 1);
      assert.strictEqual(added?.dflt_value, "'tofu'");
      assert.strictEqual(added?.pk, 0, "the primary key stays the source pair alone");

      // 043's continuity guarantee is untouched: one row per source pair.
      assert.deepEqual(
        after
          .filter((column) => column.pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => column.name),
        ["source_workspace_id", "source_environment_id"],
      );
    }),
  );

  it.effect("backfills every row pinned before 050 as trust-on-first-use", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO workjet_mailbox_peer_keys
          (source_workspace_id, source_environment_id, public_key, encryption_public_key,
           first_seen_at_ms)
        VALUES ('workjet-mesh-peer', 'environment-peer', 'signing-key', 'encryption-key', 1000)
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      // The pre-050 row keeps its keys and gains the only level it can honestly
      // claim: nothing about it was ever proven beyond first use.
      const rows = yield* sql<{
        readonly key_binding: string;
        readonly public_key: string;
      }>`SELECT key_binding, public_key FROM workjet_mailbox_peer_keys`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.key_binding, "tofu");
      assert.strictEqual(rows[0]?.public_key, "signing-key");
    }),
  );
});
