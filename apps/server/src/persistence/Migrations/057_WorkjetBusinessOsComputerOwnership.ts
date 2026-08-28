// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable Business OS -> Code-computer ownership.
 *
 * `environment_id` is the primary key because a Code environment may have
 * exactly one Business OS owner. Assigning it again is a move, not a second
 * edge. Instance and host authority deliberately do not live here: they are
 * resolved server-side at assignment time and must never become client flags.
 *
 * There is intentionally no backfill. Existing Computers predate a canonical
 * Business OS identity, so guessing an owner from a hostname, connection kind,
 * or the fact that only one instance is currently visible would manufacture an
 * authority relation the server cannot prove.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_business_os_computer_owners (
      environment_id TEXT PRIMARY KEY,
      business_os_instance_id TEXT NOT NULL,
      assigned_at_ms INTEGER NOT NULL CHECK(assigned_at_ms >= 0),
      colocation_risk_policy_version INTEGER,
      colocation_risk_accepted_at_ms INTEGER,
      CHECK (
        (
          colocation_risk_policy_version IS NULL
          AND colocation_risk_accepted_at_ms IS NULL
        )
        OR (
          colocation_risk_policy_version = 1
          AND colocation_risk_accepted_at_ms IS NOT NULL
          AND colocation_risk_accepted_at_ms >= 0
        )
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_business_os_computer_owners_instance
    ON workjet_business_os_computer_owners(business_os_instance_id, environment_id)
  `;
});
