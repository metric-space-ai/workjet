import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Persist a delegation's terminal RESULT on its own row (docs/workjet-plan.md →
 * Wave 5: "Preserve the delegation link when a result returns to the source
 * thread").
 *
 * `result_json` holds the encoded {@link WorkjetDelegationResult} written when a
 * `running` delegation is finalized. It is deliberately NULLABLE and has no
 * default: NULL is the honest representation of "not finalized yet", which is
 * the state of every row pinned before this migration and of every non-terminal
 * delegation. Storing it lets a late or duplicate completion return the SAME
 * result instead of recomputing one.
 *
 * Additive ADD COLUMN only: the delegation body, state, terminal flag, and
 * expiry pinned by migration 042 are untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(workjet_delegations)
  `;

  if (!columns.some((column) => column.name === "result_json")) {
    yield* sql`
      ALTER TABLE workjet_delegations
      ADD COLUMN result_json TEXT
    `;
  }
});
