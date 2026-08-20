import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

layer("053_WorkjetMailboxPeerRevocations", (it) => {
  it.effect("creates the peer revocation tombstone table only at migration 53", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'workjet_mailbox_peer_revocations'
      `;
      assert.strictEqual(before.length, 0);

      yield* runMigrations({ toMigrationInclusive: 53 });

      const after = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(workjet_mailbox_peer_revocations)`;

      assert.deepEqual(columnNames(after), [
        "encryption_public_key",
        "public_key",
        "revoked_at_ms",
        "source_environment_id",
        "source_workspace_id",
      ]);

      // The KEY is part of the primary key, not just the address: one address
      // may be revoked once per key generation over its life, and every
      // generation has to stay refused.
      assert.deepEqual(
        after
          .filter((column) => column.pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => column.name),
        ["source_workspace_id", "source_environment_id", "public_key"],
      );

      // A pre-044 peer genuinely has no encryption key, so its tombstone must
      // be storable without inventing one.
      const encryption = after.find((column) => column.name === "encryption_public_key");
      assert.strictEqual(encryption?.notnull, 0);
    }),
  );

  it.effect("leaves the pin table from 043/044/050 untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO workjet_mailbox_peer_keys
          (source_workspace_id, source_environment_id, public_key, encryption_public_key,
           first_seen_at_ms, key_binding)
        VALUES ('workjet-mesh-peer', 'environment-peer', 'signing-key', 'encryption-key',
                1000, 'self-signed')
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });

      // Revocation is a RUNTIME operator action, never a migration effect: no
      // existing pin may be destroyed by upgrading.
      const rows = yield* sql<{
        readonly public_key: string;
        readonly key_binding: string;
      }>`SELECT public_key, key_binding FROM workjet_mailbox_peer_keys`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.public_key, "signing-key");
      assert.strictEqual(rows[0]?.key_binding, "self-signed");

      const revocations = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS "count" FROM workjet_mailbox_peer_revocations`;
      assert.strictEqual(revocations[0]?.count, 0);
    }),
  );

  it.effect("keeps a second revocation of the same key idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });

      for (const at of [1000, 2000]) {
        yield* sql`
          INSERT OR REPLACE INTO workjet_mailbox_peer_revocations
            (source_workspace_id, source_environment_id, public_key, encryption_public_key,
             revoked_at_ms)
          VALUES ('workjet-mesh-peer', 'environment-peer', 'signing-key', 'encryption-key', ${at})
        `;
      }
      // A DIFFERENT key generation for the same address is a SECOND tombstone,
      // not a replacement: revoking a rotated key must not un-revoke its
      // predecessor.
      yield* sql`
        INSERT OR REPLACE INTO workjet_mailbox_peer_revocations
          (source_workspace_id, source_environment_id, public_key, encryption_public_key,
           revoked_at_ms)
        VALUES ('workjet-mesh-peer', 'environment-peer', 'signing-key-2', NULL, 3000)
      `;

      const rows = yield* sql<{
        readonly public_key: string;
        readonly revoked_at_ms: number;
      }>`SELECT public_key, revoked_at_ms FROM workjet_mailbox_peer_revocations ORDER BY public_key`;
      assert.deepEqual(
        rows.map((row) => [row.public_key, row.revoked_at_ms]),
        [
          ["signing-key", 2000],
          ["signing-key-2", 3000],
        ],
      );
    }),
  );
});
