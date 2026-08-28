import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable markers for the two reconciler re-scans that previously had none
 * (docs/workjet-plan.md → Wave 5 follow-ups).
 *
 * On `workjet_delegations` — the CROSS-ENVIRONMENT result-redelivery marker:
 *
 * - `result_enqueued_at_ms`      — when the delegation's result envelope was
 *   successfully handed to the outbox (or, for a SAME-environment source, when
 *   the result activity path settled the return). A row with a persisted result
 *   and a NULL marker is one whose return never completed, which is exactly the
 *   set the reconciler must retry. NULL on every pre-existing row is honest:
 *   those results were returned by the old best-effort path, so the first cycle
 *   after this migration re-attempts them — idempotently, because the result
 *   envelope id is derived from the delegation id and the outbox deduplicates on
 *   it.
 * - `result_enqueue_failed_at_ms` — when the retry hit a PERMANENT failure (an
 *   encode or signing rejection, or a delegation row this server can no longer
 *   decode). Retrying such a row forever would be a hot loop against a fault
 *   that cannot resolve itself, so the marker stops the re-scan while leaving
 *   the durable result untouched on the row.
 *
 * On `workjet_mailbox_outbox` — the DEAD-LETTER reconciliation marker:
 *
 * - `reconciled_at_ms` — when the reconciler examined this dead row. Without it
 *   every dead envelope is re-read on every ten-second cycle for as long as the
 *   row exists. NULL is the correct value for every pre-existing dead row: the
 *   reconciliation is idempotent (a terminal delegation is skipped), so a legacy
 *   row is simply reconciled once more and then marked.
 *
 * All three are NULLABLE with no default, and additive ADD COLUMN only: the
 * delegation body, state, terminal flag, expiry, result, and accounting columns
 * pinned by migrations 042/047/048, and the outbox columns pinned by 042, are
 * untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const delegationColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(workjet_delegations)
  `;
  const hasDelegationColumn = (name: string) =>
    delegationColumns.some((column) => column.name === name);

  if (!hasDelegationColumn("result_enqueued_at_ms")) {
    yield* sql`
      ALTER TABLE workjet_delegations
      ADD COLUMN result_enqueued_at_ms INTEGER
    `;
  }
  if (!hasDelegationColumn("result_enqueue_failed_at_ms")) {
    yield* sql`
      ALTER TABLE workjet_delegations
      ADD COLUMN result_enqueue_failed_at_ms INTEGER
    `;
  }

  const outboxColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(workjet_mailbox_outbox)
  `;
  if (!outboxColumns.some((column) => column.name === "reconciled_at_ms")) {
    yield* sql`
      ALTER TABLE workjet_mailbox_outbox
      ADD COLUMN reconciled_at_ms INTEGER
    `;
  }
});
