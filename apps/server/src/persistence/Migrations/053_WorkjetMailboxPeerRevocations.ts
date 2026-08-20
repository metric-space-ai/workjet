import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Operator revocation of a pinned mesh peer (docs/workjet-plan.md → "revocable
 * environment credentials" in the remote-dispatch security invariant, and the
 * key-ROTATION gap on the replication line in Wave 5).
 *
 * WHAT WAS BROKEN. 043 pinned a peer's Ed25519 signing key, 044 its X25519
 * encryption key, 050 recorded HOW strongly they were bound. All three are
 * append-only: the first envelope that verifies pins the keys forever and every
 * later different key is refused as `signing-key-conflict` /
 * `encryption-key-conflict`. That refusal is correct against an impersonator
 * and a DEAD END against a legitimate rotation — a peer that reinstalled, or an
 * operator who rotated a compromised key on purpose, is locked out permanently
 * with no recovery path. 043's own docstring deferred rotation to a
 * CTOX-room-derived binding that has not landed and is out of Workjet's reach.
 *
 * WHY A TOMBSTONE TABLE AND NOT JUST A DELETE. Revocation has to do two things
 * that pull in opposite directions:
 *
 *  1. Let the peer re-pin. The pin row is DELETED, so the next envelope that
 *     verifies from that address is a first-use event again and pins the NEW
 *     key. Nothing else would let a rotated peer back in.
 *  2. Keep the REVOKED key out. If deletion were the whole story, an attacker
 *     holding the old key — the exact case an operator revokes for — simply
 *     sends one envelope after the revocation and re-establishes the pin the
 *     operator just destroyed. This table is what makes revocation stick: the
 *     revoked keys are remembered, and `acceptPeerKey` refuses them with
 *     `key-revoked` forever after.
 *
 * So a revocation narrows what this machine will accept; it never widens it.
 * The window it opens is "some key may be pinned for this address", which is
 * the same trust-on-first-use window the address had before its first contact —
 * and the operator opened it deliberately, with an audited action.
 *
 * WHY BOTH KEY COLUMNS. The X25519 encryption key is the one an attacker
 * actually wants (it redirects every future sealed reply), so tombstoning the
 * signing key alone would leave a compromised encryption key re-pinnable
 * alongside a fresh signing key. `encryption_public_key` is nullable because a
 * pre-044 row, or a peer that never advertised one, genuinely has none.
 *
 * The primary key is (workspace, environment, public_key) rather than the
 * address alone: an address may be revoked more than once over its life — once
 * per key generation — and every generation must stay refused. `INSERT OR
 * REPLACE` on a repeat revocation of the SAME key keeps the operation
 * idempotent without losing a distinct earlier generation.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_mailbox_peer_revocations (
      source_workspace_id TEXT NOT NULL,
      source_environment_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      encryption_public_key TEXT,
      revoked_at_ms INTEGER NOT NULL,
      PRIMARY KEY (source_workspace_id, source_environment_id, public_key)
    )
  `;

  // The pull loop's revocation check reads by ADDRESS and then compares both
  // key columns in memory, because the encryption key is not part of the
  // primary key and an `OR` across two columns cannot use it. The address
  // prefix of the primary key already serves that read; this index serves the
  // operator-facing "what has been revoked here, and when" ordering instead.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_mailbox_peer_revocations_revoked_at
    ON workjet_mailbox_peer_revocations(revoked_at_ms)
  `;
});
