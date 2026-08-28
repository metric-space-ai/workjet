import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The encryption half of peer key continuity for the Workjet mailbox transport
 * (docs/workjet-plan.md → Wave 5, "Encrypt message/delegation payloads end to
 * end to the target environment key").
 *
 * 043 pinned the peer's Ed25519 SIGNING key, which answers "did this peer send
 * this envelope". Sealing needs the complementary fact: "which X25519 key does
 * this peer read". This migration adds that second key ADDITIVELY to the same
 * row, because both keys describe the same peer identity and pinning them apart
 * would create two continuity records that could disagree.
 *
 * INTERIM KEY EXCHANGE — read this before relying on it.
 *
 * There is still no key directory. Every outbound transport wrapper carries the
 * sender's own encryption key next to its signing key, and the receiver pins
 * that key on first contact under the SAME trust-on-first-use rule 043
 * documents: first key wins, a later different key from the same source pair is
 * rejected and consumed, never silently adopted. The consequence is a
 * deliberate, bounded asymmetry:
 *
 *   the very FIRST envelope to a peer this machine has never heard from cannot
 *   be sealed, because its encryption key is not yet known. It travels as
 *   `{plain, reason:"recipient-key-unknown"}` — exactly the protection the
 *   transport had before this slice, inside the CTOX room trust boundary — and
 *   is counted in the transport status. Every later envelope in that direction
 *   is sealed.
 *
 * The column is NULLABLE and has no default, and that is load-bearing in two
 * ways. Rows pinned by a pre-044 server carry no encryption key, and NULL is
 * the honest representation of "not learned yet" rather than a sentinel that
 * continuity would then have to special-case. And a v1 wrapper (migration
 * window) legitimately carries no encryption key at all, so ingesting one must
 * leave the column untouched rather than clear a key already learned.
 *
 * SQLite's `ALTER TABLE … ADD COLUMN` is O(1) metadata-only for a nullable
 * column with no default, so this is safe on a large table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite has no `ADD COLUMN IF NOT EXISTS`. The migrator runs each id exactly
  // once, so a plain ADD COLUMN is correct; the pragma check keeps a database
  // that was manually repaired from turning a re-run into a hard failure.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(workjet_mailbox_peer_keys)
  `;
  if (columns.some((column) => column.name === "encryption_public_key")) return;

  yield* sql`
    ALTER TABLE workjet_mailbox_peer_keys
    ADD COLUMN encryption_public_key TEXT
  `;
});
