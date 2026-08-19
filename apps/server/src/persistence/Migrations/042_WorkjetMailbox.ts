import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable Workjet mailbox tables (docs/workjet-plan.md → "Distributed worker
 * mailbox and delegation graph"): the source outbox, the target inbox, and the
 * delegation state, all persisted transactionally on their authoritative
 * server.
 *
 * Representation notes:
 *
 * - The canonical contract values live in the JSON columns and are encoded and
 *   decoded exclusively through the `@t3tools/contracts` mailbox schemas.
 * - Every timestamp that participates in an ORDER BY or a range comparison is
 *   duplicated as an INTEGER epoch-millisecond column. `WorkjetMailboxTimestamp`
 *   permits both `Z` and numeric UTC offsets and one to nine fractional digits,
 *   so a lexicographic comparison over the ISO text would be unsound; the
 *   integer column makes expiry and backoff scheduling exact.
 * - The inbox stores `expires_at_ms` in addition to the plan's minimum column
 *   set so the expiry sweep can drop overdue envelopes without decoding every
 *   stored payload. Replaying such an envelope is still safe: the idempotent
 *   inbox insertion rejects an envelope whose `expiresAt` has passed before it
 *   consults the deduplication key.
 * - `workjet_delegations.expires_at_ms` mirrors the delegation BUDGET expiry
 *   (the task-level deadline), not the envelope expiry used by transport.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_mailbox_outbox (
      envelope_id TEXT PRIMARY KEY,
      routing_envelope_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'dead')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      delivered_at_ms INTEGER,
      dead_lettered_at_ms INTEGER
    )
  `;

  // Serves listPendingOutbound(now, limit): the state filter, the
  // next_attempt_at cutoff, and the (next_attempt_at, created_at) page order.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_mailbox_outbox_pending
    ON workjet_mailbox_outbox(state, next_attempt_at_ms, created_at_ms)
  `;

  // Serves the outbox half of expireOverdue(now).
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_mailbox_outbox_expiry
    ON workjet_mailbox_outbox(state, expires_at_ms)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_mailbox_inbox (
      envelope_id TEXT PRIMARY KEY,
      routing_envelope_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL,
      processed_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    )
  `;

  // Serves listUnprocessedInbound: unprocessed rows in arrival order.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_mailbox_inbox_unprocessed
    ON workjet_mailbox_inbox(processed_at_ms, received_at_ms)
  `;

  // Serves the inbox half of expireOverdue(now).
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_mailbox_inbox_expiry
    ON workjet_mailbox_inbox(expires_at_ms)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_delegations (
      delegation_id TEXT PRIMARY KEY,
      delegation_json TEXT NOT NULL,
      state TEXT NOT NULL,
      state_changed_at_ms INTEGER NOT NULL,
      terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
      expires_at_ms INTEGER NOT NULL
    )
  `;

  // Serves listDelegationsByState.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_delegations_state
    ON workjet_delegations(state, state_changed_at_ms)
  `;

  // Serves the delegation half of expireOverdue(now): non-terminal rows past
  // their budget expiry.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workjet_delegations_expiry
    ON workjet_delegations(terminal, expires_at_ms)
  `;
});
