import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A final native task no longer needs admission polling after a restart. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE workjet_ctox_native_turns
    ADD COLUMN admission_terminal_at_ms INTEGER
  `;
  yield* sql`
    CREATE INDEX workjet_ctox_native_turns_pending_admission
    ON workjet_ctox_native_turns(sequence)
    WHERE admission_terminal_at_ms IS NULL
  `;
});
