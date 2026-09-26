import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Pin the provider conversation used by the original claimed Crew attempt. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE workjet_ctox_crew_starts
    ADD COLUMN codex_resume_thread_id TEXT
      CHECK (codex_resume_thread_id IS NULL OR length(codex_resume_thread_id) BETWEEN 1 AND 256)
  `;
});
