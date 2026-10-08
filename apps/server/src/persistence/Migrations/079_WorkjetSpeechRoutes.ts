// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Per-session-kind speech computer routes.
 *
 * One row per session kind. A NULL computer means the server's standard
 * resolution applies; it is never a silent fallback to another computer.
 * Speech availability is not stored here: it is reported by the computer and
 * stays unknown until confirmed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_speech_routes (
      session_kind TEXT PRIMARY KEY CHECK(session_kind IN ('regeltermin', 'spontan')),
      stt_environment_id TEXT,
      tts_environment_id TEXT
    )
  `;
});
