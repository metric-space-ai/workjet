// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable, secret-free Workjet device pairing state.
 *
 * References contain only a hash of the one-time code and the selected
 * Business-OS scope. Bootstrap, signaling and capability secrets are minted
 * only after a successful redemption and never stored in these tables.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_device_invite_references (
      invite_id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      endpoint TEXT NOT NULL,
      business_os_instance_id TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
      consumed_at_ms INTEGER,
      revoked_at_ms INTEGER,
      CHECK(consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
      CHECK(revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_device_invite_references_expiry
    ON workjet_device_invite_references(expires_at_ms)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_device_bindings (
      device_pairing_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      proof_key_thumbprint TEXT NOT NULL,
      business_os_instance_id TEXT NOT NULL,
      environment_pairing_link_id TEXT NOT NULL UNIQUE,
      ctox_invite_id TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
      revoked_at_ms INTEGER,
      UNIQUE(device_id, business_os_instance_id),
      CHECK(revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_device_bindings_instance
    ON workjet_device_bindings(business_os_instance_id, revoked_at_ms, device_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_device_invite_rate_limits (
      rate_key_hash TEXT PRIMARY KEY,
      window_started_at_ms INTEGER NOT NULL CHECK(window_started_at_ms >= 0),
      attempts INTEGER NOT NULL CHECK(attempts >= 0),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= window_started_at_ms)
    )
  `;
});
