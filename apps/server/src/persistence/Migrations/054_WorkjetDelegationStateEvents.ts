import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * An append-only log of every delegation state transition (docs/
 * workjet-remaining-work.md item 10, plan §8).
 *
 * WHAT WAS MISSING. A delegation's state lived only in the mutable
 * `workjet_delegations.state` column, which each transition OVERWRITES. The
 * row therefore answers "where is this now" and nothing else: how it got
 * there, how long it sat in each state, whether it was retried, and — the case
 * that matters most — whether a transition happened at all are all
 * unanswerable after the fact. A delegation that went `queued → delivered →
 * failed` is indistinguishable from one that went straight to `failed`, so a
 * post-mortem cannot tell a delivery problem from an execution problem.
 *
 * WHY IN THE SAME TRANSACTION. The event is written inside
 * `transitionDelegationState`'s existing transaction, not after it. Anything
 * else admits the two states this table exists to rule out: a row that moved
 * with no event (a silent transition), and an event for a move that was rolled
 * back (a lie). Because the transition already re-reads the row and enforces
 * legality under that same transaction, the event's `from_state` is the state
 * actually observed, not one the caller asserted.
 *
 * WHY APPEND-ONLY, AND WHY NO UNIQUE KEY ON THE TRANSITION. There is
 * deliberately no `UNIQUE(delegation_id, from_state, to_state)`: a legal cycle
 * — say a retry returning to `queued` — must record BOTH passes, and a unique
 * key would silently collapse them into one and destroy exactly the retry
 * history this is for. Ordering comes from the autoincrement `sequence`, not
 * from the timestamp: two transitions can share a millisecond, and a clock
 * that steps backwards must not reorder history.
 *
 * WHAT IT MUST NOT CARRY. Ids, closed state literals and a timestamp only —
 * no prompt text, no payload, no worker output. The delegation row already
 * holds the reference-only payload, and a log that accumulated content would
 * become an unbounded copy of it, outliving the retention of the thing it
 * describes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_delegation_state_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      delegation_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      terminal INTEGER NOT NULL,
      changed_at_ms INTEGER NOT NULL
    )
  `;

  // The only read this table has: one delegation's history, oldest first.
  // `sequence` is included so the index answers the ordering too rather than
  // handing SQLite a sort over the matched rows.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_delegation_state_events_delegation
    ON workjet_delegation_state_events(delegation_id, sequence)
  `;
});
