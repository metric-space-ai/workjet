import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Trust-on-first-use peer key continuity for the Workjet mailbox transport
 * (docs/workjet-plan.md → Wave 5, "Distributed worker mailbox and delegation
 * graph", 2026-08-19 docking decision).
 *
 * INTERIM MECHANISM — read this before relying on it.
 *
 * The local CTOX daemon replicates envelope documents OPAQUELY: it never parses
 * or verifies `envelope_json`, so the daemon cannot tell Workjet which public
 * key a peer legitimately owns. Until the CTOX-room-derived identity binding
 * lands (the same open item that will replace the generated
 * `WorkjetMeshWorkspaceId`), a pulled envelope carries its own
 * `senderPublicKey` inside the transport payload wrapper. A self-asserted key
 * alone proves nothing, so this table adds the missing half:
 *
 *   trust root = CTOX room membership (only paired machines replicate at all)
 *              + key continuity (TOFU) recorded here
 *
 * The FIRST envelope seen from a `(source_workspace_id, source_environment_id)`
 * pair pins that pair's public key forever. A later envelope from the same
 * source carrying a DIFFERENT key is rejected with a typed reason and counted,
 * never silently adopted — silent adoption would make the self-asserted key
 * worthless, because any room member could then impersonate any other.
 *
 * The row is deliberately minimal and append-only in practice: no rotation
 * column, no revocation column, no expiry. A key rotation is an operator event
 * that the CTOX-room-derived binding will own; inventing a rotation protocol
 * here would create a second, weaker identity authority that the real one would
 * then have to be reconciled against.
 *
 * `first_seen_at_ms` is an epoch-millisecond INTEGER for the same reason every
 * other mailbox timestamp is (see 042_WorkjetMailbox): `WorkjetMailboxTimestamp`
 * text is not soundly comparable lexicographically.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_mailbox_peer_keys (
      source_workspace_id TEXT NOT NULL,
      source_environment_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      first_seen_at_ms INTEGER NOT NULL,
      PRIMARY KEY (source_workspace_id, source_environment_id)
    )
  `;

  // Serves the operator-facing "which peers has this machine pinned" read and
  // keeps a full-table scan out of the pull loop's continuity check.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_mailbox_peer_keys_first_seen
    ON workjet_mailbox_peer_keys(first_seen_at_ms)
  `;
});
