import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The TRUST LEVEL of a peer pin (docs/workjet-plan.md → Wave 5 security
 * follow-up, "the CTOX room secret is deliberately NOT the only security
 * boundary").
 *
 * 043 pinned the peer's Ed25519 signing key and 044 its X25519 encryption key.
 * Both were pinned on pure trust-on-first-use, and the row recorded nothing
 * about HOW the keys were learned. That omission is the problem this column
 * fixes, because the two ways a key can arrive are not equally trustworthy:
 *
 * - The signing key has always been proven-possessed. The routing envelope is
 *   verified against it BEFORE the pin, so a peer cannot pin a signing key it
 *   does not hold.
 * - The encryption key was NOT. It rides in `payload_json`, which no signature
 *   covered, so any room member able to write the collection could publish an
 *   otherwise-honest envelope with its OWN encryption key substituted in — and
 *   every later sealed reply to that peer would be readable by the substituter.
 *
 * The transport now emits a self-signed KEY BINDING (see
 * `WORKJET_MESH_KEY_BINDING_DOMAIN`) covering both public keys, the claimed
 * source pair, and the envelope id. This column records whether the pin was
 * established under a verified binding, so that:
 *
 *  1. the roster can tell the user which trust level a peer actually has
 *     instead of implying every pinned peer is equally verified, and
 *  2. a peer pinned as `self-signed` can never be DOWNGRADED back to `tofu` by
 *     a later wrapper that simply omits the binding — a strip-the-binding
 *     attack the column is what makes detectable.
 *
 * `'tofu'` is the DEFAULT and the NOT NULL value on purpose. Every row pinned
 * before this migration was established without a binding, and `'tofu'` states
 * that honestly; a nullable column would leave "unknown", which the downgrade
 * check would then have to guess at, and guessing in favour of the attacker is
 * how a check like this stops working.
 *
 * SQLite's `ALTER TABLE … ADD COLUMN` with a constant default is O(1)
 * metadata-only, so this is safe on a large table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite has no `ADD COLUMN IF NOT EXISTS`. The migrator runs each id exactly
  // once, so a plain ADD COLUMN is correct; the pragma check keeps a database
  // that was manually repaired from turning a re-run into a hard failure.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(workjet_mailbox_peer_keys)
  `;
  if (columns.some((column) => column.name === "key_binding")) return;

  yield* sql`
    ALTER TABLE workjet_mailbox_peer_keys
    ADD COLUMN key_binding TEXT NOT NULL DEFAULT 'tofu'
  `;
});
