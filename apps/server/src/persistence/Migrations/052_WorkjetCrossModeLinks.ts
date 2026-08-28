import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The durable cross-mode link table (docs/workjet-plan.md → "Cross-mode
 * workflow bridge": "Business OS can create or delegate implementation work to
 * a Code thread and retain a durable link to the resulting environment, thread,
 * run, and artifacts").
 *
 * A link is NOT a delegation and NOT a handoff, and deliberately reuses neither
 * table. It has no lifecycle state machine, no budget, no graph depth, no
 * snapshot, and no expiry sweep; it has exactly one durable question — "which
 * Code thread implements this Business OS object, and which Business OS object
 * does this Code thread implement" — which is a symmetric two-sided lookup that
 * nullable columns on either existing row could not express honestly.
 *
 * Representation notes, following migrations 042/045/051:
 *
 * - The canonical contract value lives in `link_json` and is encoded and decoded
 *   exclusively through the `@t3tools/contracts` `WorkjetCrossModeLink` schema.
 *   The columns beside it are duplicated OUT of that JSON so a bounded listing
 *   and both directional lookups never have to decode every row.
 * - `link_id` is the PRIMARY KEY and is chosen by THIS server, never by a
 *   client: a caller that could pin a link id could repoint an existing link's
 *   references at a different object by claiming its id.
 * - The CTOX-side lookup key is the composite
 *   `(ctox_instance_id, ctox_module_id, ctox_object_kind, ctox_object_id)`, and
 *   it is UNIQUE. That uniqueness IS the "create or select" invariant of
 *   `Delegate to Code` / `Open in Code`: a second delegation for the same
 *   Business OS object cannot produce a second link, and therefore cannot
 *   produce a second Code thread, no matter how the requests interleave. It is
 *   an invariant of the database rather than a hope about request ordering.
 * - `code_thread_id` is UNIQUE for the mirrored reason: one Code thread carries
 *   at most one cross-mode backlink, so "which object does this thread
 *   implement" has exactly one answer and the Code-side affordances can never
 *   render two conflicting counterparts.
 * - `code_environment_id` is stored even though every row this server writes
 *   carries its own environment id. It is the AUTHORITY the link names, and
 *   keeping it as a column means a later multi-environment read can filter on it
 *   without decoding, and a row whose authority does not match the server that
 *   opens the database is detectable rather than silently adopted.
 * - `expires_at_ms` is NULL for the ordinary case. Most links do not expire,
 *   because a Business OS object and the Code thread implementing it stay
 *   related indefinitely; NULL means "no expiry", never "expired".
 * - The `_ms` columns are INTEGER epoch-millisecond mirrors of the contract's
 *   ISO timestamps, used for deterministic ordering; the ISO text permits both
 *   `Z` and numeric offsets, so a lexicographic comparison would be unsound —
 *   the same reasoning as migration 042.
 *
 * Nothing here stores a Business OS record. `link_json` encodes typed references
 * plus the contract's bounded, redacted title/subtitle, and the schema makes any
 * other field unrepresentable. There is no room in this table for a row of the
 * counterpart's database, which is the plan's constraint made physical.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_cross_mode_links (
      link_id TEXT PRIMARY KEY,
      ctox_instance_id TEXT NOT NULL,
      ctox_module_id TEXT NOT NULL,
      ctox_object_kind TEXT NOT NULL,
      ctox_object_id TEXT NOT NULL,
      code_environment_id TEXT NOT NULL,
      code_thread_id TEXT NOT NULL UNIQUE,
      link_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER
    )
  `;

  // The create-or-select invariant: one Business OS object has at most one link.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workjet_cross_mode_links_object
    ON workjet_cross_mode_links(
      ctox_instance_id, ctox_module_id, ctox_object_kind, ctox_object_id
    )
  `;

  // Serves the bounded listing: newest link first, stable on ties.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_cross_mode_links_created
    ON workjet_cross_mode_links(created_at_ms DESC, link_id ASC)
  `;
});
