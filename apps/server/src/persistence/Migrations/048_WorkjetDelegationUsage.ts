import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Per-delegation USAGE accounting and the human-approval gate (docs/workjet-plan.md
 * → Wave 5: "token/cost/time budgets, and approval gates to prevent autonomous
 * infinite loops"). Depth, review rounds, and time (expiry) already have durable
 * ceilings; this migration adds the surface the token/cost budgets and the
 * approval gate accumulate against.
 *
 * Three additive columns on `workjet_delegations`, orthogonal to the state
 * transition table and the delegation body:
 *
 * - `usage_tokens`      — cumulative tokens charged to this delegation.
 * - `usage_cost_micros` — cumulative cost in MICRO-currency (1e-6 of a unit).
 * - `approval_state`    — the {@link WorkjetDelegationApprovalState} literal.
 *
 * The two usage columns default to 0 and are NOT NULL: "nothing charged yet" is
 * an honest zero, and a delegation pinned before this migration has genuinely
 * accumulated nothing. `approval_state` defaults to `'not-required'`, which is
 * the correct meaning for every pre-existing row (none of them carried a
 * `requiresApproval` gate). A gated delegation is written `'pending'` by the
 * store's upsert, never by this default.
 *
 * Additive ADD COLUMN only: the delegation body, state, terminal flag, expiry,
 * and result column pinned by migrations 042/047 are untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(workjet_delegations)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("usage_tokens")) {
    yield* sql`
      ALTER TABLE workjet_delegations
      ADD COLUMN usage_tokens INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!has("usage_cost_micros")) {
    yield* sql`
      ALTER TABLE workjet_delegations
      ADD COLUMN usage_cost_micros INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!has("approval_state")) {
    yield* sql`
      ALTER TABLE workjet_delegations
      ADD COLUMN approval_state TEXT NOT NULL DEFAULT 'not-required'
    `;
  }
});
