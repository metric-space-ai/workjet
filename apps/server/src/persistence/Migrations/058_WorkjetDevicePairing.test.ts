// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const tableColumns = (tableName: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${tableName}) ORDER BY cid
    `;
    return rows.map((row) => row.name);
  });

describe("058_WorkjetDevicePairing", () => {
  it.effect("creates durable secret-free reference, binding and limiter tables", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 57 });
        const before = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'workjet_device_%'
          ORDER BY name
        `;
        assert.deepEqual(before, []);

        yield* runMigrations({ toMigrationInclusive: 58 });
        assert.deepEqual(yield* tableColumns("workjet_device_invite_references"), [
          "invite_id",
          "code_hash",
          "endpoint",
          "business_os_instance_id",
          "expires_at_ms",
          "created_at_ms",
          "consumed_at_ms",
          "revoked_at_ms",
        ]);
        assert.deepEqual(yield* tableColumns("workjet_device_bindings"), [
          "device_pairing_id",
          "device_id",
          "proof_key_thumbprint",
          "business_os_instance_id",
          "environment_pairing_link_id",
          "ctox_invite_id",
          "created_at_ms",
          "revoked_at_ms",
        ]);
        assert.deepEqual(yield* tableColumns("workjet_device_invite_rate_limits"), [
          "rate_key_hash",
          "window_started_at_ms",
          "attempts",
          "updated_at_ms",
        ]);
      }),
    ),
  );

  it.effect("enforces one active edge per device and instance", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 58 });
        yield* sql`
          INSERT INTO workjet_device_bindings (
            device_pairing_id, device_id, proof_key_thumbprint,
            business_os_instance_id, environment_pairing_link_id,
            ctox_invite_id, created_at_ms, revoked_at_ms
          ) VALUES (
            'pairing-a', 'device-a', 'thumb-a', 'business-os-a',
            'environment-link-a', 'ctox-invite-a', 100, NULL
          )
        `;
        const duplicate = yield* sql`
          INSERT INTO workjet_device_bindings (
            device_pairing_id, device_id, proof_key_thumbprint,
            business_os_instance_id, environment_pairing_link_id,
            ctox_invite_id, created_at_ms, revoked_at_ms
          ) VALUES (
            'pairing-b', 'device-a', 'thumb-b', 'business-os-a',
            'environment-link-b', 'ctox-invite-b', 200, NULL
          )
        `.pipe(Effect.result);
        assert.equal(duplicate._tag, "Failure");

        const otherInstance = yield* sql`
          INSERT INTO workjet_device_bindings (
            device_pairing_id, device_id, proof_key_thumbprint,
            business_os_instance_id, environment_pairing_link_id,
            ctox_invite_id, created_at_ms, revoked_at_ms
          ) VALUES (
            'pairing-c', 'device-a', 'thumb-c', 'business-os-b',
            'environment-link-c', 'ctox-invite-c', 300, NULL
          )
        `.pipe(Effect.result);
        assert.equal(otherInstance._tag, "Success");
      }),
    ),
  );
});
