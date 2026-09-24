import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Pin a driver-qualified provider conversation before the first claimed send. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE workjet_ctox_crew_starts ADD COLUMN provider_driver_kind TEXT
      CHECK (provider_driver_kind IS NULL OR length(provider_driver_kind) BETWEEN 1 AND 64)
  `;
  yield* sql`
    ALTER TABLE workjet_ctox_crew_starts ADD COLUMN provider_resume_identity TEXT
      CHECK (provider_resume_identity IS NULL OR length(provider_resume_identity) BETWEEN 1 AND 256)
  `;
  yield* sql`
    UPDATE workjet_ctox_crew_starts
    SET provider_driver_kind = 'codex', provider_resume_identity = codex_resume_thread_id
    WHERE codex_resume_thread_id IS NOT NULL
  `;
});
