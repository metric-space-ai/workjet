// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Immutable assignment and assessment evidence for empirical worker selection. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_team_selections (
      selection_id TEXT PRIMARY KEY,
      worker_thread_id TEXT NOT NULL UNIQUE,
      candidate_key TEXT NOT NULL,
      task_type TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      randomized INTEGER NOT NULL CHECK(randomized IN (0, 1)),
      draw REAL NOT NULL CHECK(draw >= 0 AND draw < 1),
      mode TEXT NOT NULL CHECK(mode IN ('uniform', 'adaptive')),
      selected_at_ms INTEGER NOT NULL CHECK(selected_at_ms >= 0)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workjet_team_reviews (
      review_id TEXT PRIMARY KEY,
      selection_id TEXT NOT NULL REFERENCES workjet_team_selections(selection_id),
      phase TEXT NOT NULL CHECK(phase IN ('first-delivery', 'final-delivery', 'handover', 'review', 'lifecycle')),
      score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 10),
      cause TEXT NOT NULL CHECK(cause IN ('model', 'task_spec', 'unknown')),
      reviewer_thread_id TEXT NOT NULL,
      subject_thread_id TEXT NOT NULL,
      execution_json TEXT NOT NULL,
      practice TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      recorded_at_ms INTEGER NOT NULL CHECK(recorded_at_ms >= 0)
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS workjet_team_reviews_delivery_once
    ON workjet_team_reviews(selection_id, phase)
    WHERE phase IN ('first-delivery', 'final-delivery')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS workjet_team_selections_comparison
    ON workjet_team_selections(task_type, difficulty, reasoning, candidate_key)
  `;
});
