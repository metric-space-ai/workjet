import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The single Workjet delegation GRAPH edge table (docs/workjet-plan.md →
 * "Represent review and revision as typed edges (`reviews`, `revises`,
 * `follows-up`) in one delegation graph").
 *
 * Representation notes:
 *
 * - The canonical contract value lives in `edge_json` and is encoded and
 *   decoded exclusively through the `@t3tools/contracts` `WorkjetDelegationEdge`
 *   schema, exactly like the mailbox tables in migration 042.
 * - `edge_id` is the PRIMARY KEY and is DERIVED from the edge's `kind`, `from`,
 *   and `to` refs (see {@link workjetDelegationEdgeId} in
 *   `WorkjetMailboxStore.ts`). A stable id makes insertion idempotent under
 *   at-least-once transport: re-inserting the identical relationship is a
 *   no-op, never a duplicate row.
 * - `from_delegation_id` and `to_delegation_id` are duplicated out of the JSON
 *   so `listDelegationEdges(delegationId)` can find every edge touching a
 *   delegation without decoding every stored row.
 * - `created_at_ms` is the INTEGER epoch-millisecond mirror of the edge's ISO
 *   `createdAt`, used for a deterministic listing order; the ISO text permits
 *   both `Z` and numeric offsets so a lexicographic comparison would be
 *   unsound, matching the reasoning in migration 042.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_delegation_edges (
      edge_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('reviews', 'revises', 'follows-up')),
      from_delegation_id TEXT NOT NULL,
      to_delegation_id TEXT NOT NULL,
      edge_json TEXT NOT NULL,
      depth INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `;

  // Serves the "from" half of listDelegationEdges(delegationId).
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_delegation_edges_from
    ON workjet_delegation_edges(from_delegation_id, created_at_ms)
  `;

  // Serves the "to" half of listDelegationEdges(delegationId).
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_delegation_edges_to
    ON workjet_delegation_edges(to_delegation_id, created_at_ms)
  `;
});
