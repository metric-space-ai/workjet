import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The RECEIVING side of the typed thread handoff (docs/workjet-plan.md → "Add
 * the typed thread-handoff contract and flow (immutable prompt/context
 * snapshot, bounded artifact references, pushed or sync-bundled Git branch,
 * durable source-thread link); the target machine continues in a new thread
 * with any harness/LLM").
 *
 * A handoff is NOT a delegation and deliberately does not reuse
 * `workjet_delegations`: it owns no lifecycle state machine, no budget, no
 * graph depth, and no target thread. It has exactly one durable question —
 * "was this handoff continued here, and in which thread" — so it gets its own
 * small table rather than nullable columns bolted onto a row whose invariants
 * do not apply.
 *
 * Representation notes, following migrations 042/045:
 *
 * - The canonical contract value lives in `handoff_json` and is encoded and
 *   decoded exclusively through the `@t3tools/contracts` `WorkjetThreadHandoff`
 *   schema. The columns beside it are duplicated OUT of that JSON so a bounded
 *   inbox listing never has to decode every row to sort or filter it.
 * - `handoff_id` is the PRIMARY KEY and comes from the sender, which makes the
 *   receiving upsert idempotent under at-least-once transport: the same handoff
 *   arriving twice is one row, never two inbox entries.
 * - `envelope_id` is UNIQUE for the same reason from the other direction: two
 *   different handoff ids may never claim one envelope.
 * - `accepted_thread_id` is THE durable source-thread link, read in both
 *   directions: from the handoff row to the thread that continues the work, and
 *   — via `source_thread_id` on the same row — from that thread back to the
 *   thread the work came from. It is UNIQUE, so a thread can continue at most
 *   one handoff, and it is NULL until an accept lands. The accept writes it
 *   conditionally (`WHERE accepted_thread_id IS NULL`), which is what makes
 *   "a handoff creates exactly one thread" an invariant of the database rather
 *   than a hope about request ordering.
 * - `snapshot_digest` duplicates the context snapshot's digest so the inbox
 *   read can ask the content-addressed snapshot store whether the bytes are
 *   present on THIS machine without decoding the JSON body.
 * - The `_ms` columns are INTEGER epoch-millisecond mirrors of the contract's
 *   ISO timestamps, used for deterministic ordering; the ISO text permits both
 *   `Z` and numeric offsets, so a lexicographic comparison would be unsound —
 *   the same reasoning as migration 042.
 *
 * Nothing here stores snapshot TEXT. The snapshot lives in the content-addressed
 * snapshot store exactly like a delegation prompt, and this table holds only its
 * digest and byte length via the encoded contract value.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_thread_handoffs (
      handoff_id TEXT PRIMARY KEY,
      envelope_id TEXT NOT NULL UNIQUE,
      source_workspace_id TEXT NOT NULL,
      source_environment_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      handoff_json TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      received_at_ms INTEGER NOT NULL,
      accepted_thread_id TEXT UNIQUE,
      accepted_at_ms INTEGER
    )
  `;

  // Serves the bounded inbox listing: newest arrival first, stable on ties.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_thread_handoffs_received
    ON workjet_thread_handoffs(received_at_ms DESC, handoff_id ASC)
  `;

  // Serves the backlink read in the thread → handoff direction.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_thread_handoffs_source_thread
    ON workjet_thread_handoffs(source_thread_id)
  `;
});
