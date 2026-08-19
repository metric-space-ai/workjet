import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

layer("044_WorkjetMailboxPeerEncryptionKeys", (it) => {
  it.effect("adds the peer encryption key column only at migration 44", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(workjet_mailbox_peer_keys)
      `;
      assert.notInclude(columnNames(before), "encryption_public_key");

      yield* runMigrations({ toMigrationInclusive: 44 });

      const after = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`PRAGMA table_info(workjet_mailbox_peer_keys)`;

      assert.deepEqual(columnNames(after), [
        "encryption_public_key",
        "first_seen_at_ms",
        "public_key",
        "source_environment_id",
        "source_workspace_id",
      ]);

      const added = after.find((column) => column.name === "encryption_public_key");
      assert.isDefined(added);
      // Nullable and without a default, deliberately: NULL is the honest
      // representation of "this peer has not advertised an encryption key yet",
      // which is exactly the state of every row pinned before 044 and of a v1
      // wrapper during the migration window.
      assert.strictEqual(added?.notnull, 0);
      assert.strictEqual(added?.dflt_value, null);
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

  it.effect("preserves rows pinned before the column existed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO workjet_mailbox_peer_keys
          (source_workspace_id, source_environment_id, public_key, first_seen_at_ms)
        VALUES ('workjet-mesh-room', 'environment-remote', 'signing-key-one', 10)
      `;

      // An ADD COLUMN must never rewrite or drop what 043 already pinned: the
      // signing key is the peer's identity and losing it would silently reopen
      // trust-on-first-use for an established peer.
      yield* runMigrations({ toMigrationInclusive: 44 });

      const rows = yield* sql<{
        readonly publicKey: string;
        readonly encryptionPublicKey: string | null;
        readonly firstSeenAtMs: number;
      }>`
        SELECT public_key AS "publicKey",
               encryption_public_key AS "encryptionPublicKey",
               first_seen_at_ms AS "firstSeenAtMs"
        FROM workjet_mailbox_peer_keys
      `;
      assert.deepEqual(
        [...rows],
        [{ publicKey: "signing-key-one", encryptionPublicKey: null, firstSeenAtMs: 10 }],
      );

      // The encryption key is learned later, in place, without a second row.
      yield* sql`
        UPDATE workjet_mailbox_peer_keys
        SET encryption_public_key = 'encryption-key-one'
        WHERE source_workspace_id = 'workjet-mesh-room'
          AND source_environment_id = 'environment-remote'
      `;
      const updated = yield* sql<{ readonly encryptionPublicKey: string | null }>`
        SELECT encryption_public_key AS "encryptionPublicKey"
        FROM workjet_mailbox_peer_keys
      `;
      assert.deepEqual(
        updated.map((row) => row.encryptionPublicKey),
        ["encryption-key-one"],
      );

      // The source pair is still unique, so a second key pair for one peer
      // remains impossible at the schema level rather than only in the service.
      const conflict = yield* sql`
        INSERT INTO workjet_mailbox_peer_keys
          (source_workspace_id, source_environment_id, public_key, encryption_public_key,
           first_seen_at_ms)
        VALUES ('workjet-mesh-room', 'environment-remote', 'signing-key-two',
                'encryption-key-two', 20)
      `.pipe(Effect.result);
      assert.isTrue(conflict._tag === "Failure");
    }),
  );
});
