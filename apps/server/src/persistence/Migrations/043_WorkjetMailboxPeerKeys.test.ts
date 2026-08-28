import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const names = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

layer("043_WorkjetMailboxPeerKeys", (it) => {
  it.effect("creates the trust-on-first-use peer key table only at migration 43", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name AS "name"
        FROM sqlite_master
        WHERE type = 'table' AND name = 'workjet_mailbox_peer_keys'
      `;
      assert.deepEqual(names(before), []);

      yield* runMigrations({ toMigrationInclusive: 43 });

      const after = yield* sql<{ readonly name: string }>`
        SELECT name AS "name"
        FROM sqlite_master
        WHERE type = 'table' AND name = 'workjet_mailbox_peer_keys'
      `;
      assert.deepEqual(names(after), ["workjet_mailbox_peer_keys"]);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name AS "name"
        FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'idx_workjet_mailbox_peer_keys%'
      `;
      assert.deepEqual(names(indexes), ["idx_workjet_mailbox_peer_keys_first_seen"]);
    }),
  );

  it.effect("keys a pinned public key by the (workspace, environment) source pair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(workjet_mailbox_peer_keys)`;

      assert.deepEqual(
        columns.map((column) => column.name).sort(),
        ["first_seen_at_ms", "public_key", "source_environment_id", "source_workspace_id"],
        "the table stays minimal: no rotation, revocation, or expiry column",
      );
      assert.deepEqual(
        columns
          .filter((column) => column.pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => column.name),
        ["source_workspace_id", "source_environment_id"],
        "continuity is per source pair, so one environment cannot pin another's key",
      );
      assert.isTrue(
        columns.every((column) => column.notnull === 1),
        "no column may be null: a half-recorded pin would silently disable continuity",
      );

      yield* sql`
        INSERT INTO workjet_mailbox_peer_keys
          (source_workspace_id, source_environment_id, public_key, first_seen_at_ms)
        VALUES ('workjet-mesh-room', 'environment-remote', 'key-one', 10)
      `;

      // A second key for the SAME source pair must be impossible at the schema
      // level, not merely refused by the service that writes it.
      const conflict = yield* sql`
        INSERT INTO workjet_mailbox_peer_keys
          (source_workspace_id, source_environment_id, public_key, first_seen_at_ms)
        VALUES ('workjet-mesh-room', 'environment-remote', 'key-two', 20)
      `.pipe(Effect.result);
      assert.isTrue(conflict._tag === "Failure", "the source pair must be unique");

      // A different environment in the same workspace is a different peer.
      yield* sql`
        INSERT INTO workjet_mailbox_peer_keys
          (source_workspace_id, source_environment_id, public_key, first_seen_at_ms)
        VALUES ('workjet-mesh-room', 'environment-other', 'key-three', 30)
      `;

      const rows = yield* sql<{ readonly publicKey: string }>`
        SELECT public_key AS "publicKey"
        FROM workjet_mailbox_peer_keys
        ORDER BY first_seen_at_ms
      `;
      assert.deepEqual(
        rows.map((row) => row.publicKey),
        ["key-one", "key-three"],
      );
    }),
  );
});
