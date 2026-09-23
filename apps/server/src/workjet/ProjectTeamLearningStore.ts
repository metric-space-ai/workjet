// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { ThreadId, WorkjetTeamReview } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import type { TeamSelectionObservation } from "./ProjectTeamLearning.ts";

export interface TeamSelectionRecord {
  readonly selectionId: string;
  readonly workerThreadId: ThreadId;
  /** Includes provider instance, model, harness and version; versions never pool. */
  readonly candidate: string;
  readonly taskType: string;
  readonly difficulty: string;
  readonly reasoning: string;
  readonly randomized: boolean;
  readonly draw: number;
  readonly mode: "uniform" | "adaptive";
  readonly selectedAtMillis: number;
}

export interface TeamAssessmentRecord {
  readonly selectionId: string;
  readonly review: WorkjetTeamReview;
  readonly cause: "model" | "task_spec" | "unknown";
}

export class ProjectTeamLearningEvidenceError extends Schema.TaggedErrorClass<ProjectTeamLearningEvidenceError>()(
  "ProjectTeamLearningEvidenceError",
  { detail: Schema.String },
) {}

export type ProjectTeamLearningStoreError = PersistenceSqlError | ProjectTeamLearningEvidenceError;

export interface ProjectTeamLearningStoreShape {
  /** A retry may repeat the same assignment, but cannot substitute its candidate or draw. */
  readonly recordSelection: (
    selection: TeamSelectionRecord,
  ) => Effect.Effect<void, ProjectTeamLearningStoreError>;
  /** Assessed reviews are immutable; quota/transport failures remain unassessed. */
  readonly recordAssessment: (
    assessment: TeamAssessmentRecord,
  ) => Effect.Effect<void, ProjectTeamLearningStoreError>;
  readonly listObservations: (input: {
    readonly taskType: string;
    readonly difficulty: string;
    readonly reasoning: string;
  }) => Effect.Effect<ReadonlyArray<TeamSelectionObservation>, ProjectTeamLearningStoreError>;
}

export class ProjectTeamLearningStore extends Context.Service<
  ProjectTeamLearningStore,
  ProjectTeamLearningStoreShape
>()("workjet/workjet/ProjectTeamLearningStore") {}

const evidenceError = (detail: string) => new ProjectTeamLearningEvidenceError({ detail });
const isEvidenceError = Schema.is(ProjectTeamLearningEvidenceError);
const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const transactionError = (operation: string) =>
  (cause: unknown): ProjectTeamLearningStoreError =>
    isEvidenceError(cause) || isPersistenceSqlError(cause)
      ? cause
      : toPersistenceSqlError(operation)(cause);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recordSelection: ProjectTeamLearningStoreShape["recordSelection"] = (selection) =>
    Effect.gen(function* () {
      if (
        !selection.selectionId ||
        !selection.candidate ||
        !selection.workerThreadId ||
        !Number.isFinite(selection.draw) ||
        selection.draw < 0 ||
        selection.draw >= 1 ||
        !Number.isSafeInteger(selection.selectedAtMillis) ||
        selection.selectedAtMillis < 0
      ) {
        return yield* evidenceError("Invalid team model selection evidence");
      }
      yield* sql`
        INSERT INTO workjet_team_selections (
          selection_id, worker_thread_id, candidate_key, task_type, difficulty,
          reasoning, randomized, draw, mode, selected_at_ms
        ) VALUES (
          ${selection.selectionId}, ${selection.workerThreadId}, ${selection.candidate},
          ${selection.taskType}, ${selection.difficulty}, ${selection.reasoning},
          ${selection.randomized ? 1 : 0}, ${selection.draw}, ${selection.mode},
          ${selection.selectedAtMillis}
        ) ON CONFLICT(selection_id) DO NOTHING
      `.pipe(Effect.mapError(toPersistenceSqlError("ProjectTeamLearningStore.recordSelection")));
      const rows = yield* sql<{
        readonly workerThreadId: string;
        readonly candidate: string;
        readonly taskType: string;
        readonly difficulty: string;
        readonly reasoning: string;
        readonly randomized: number;
        readonly draw: number;
        readonly mode: string;
        readonly selectedAtMillis: number;
      }>`
        SELECT worker_thread_id AS "workerThreadId", candidate_key AS "candidate",
               task_type AS "taskType", difficulty, reasoning, randomized, draw,
               mode, selected_at_ms AS "selectedAtMillis"
        FROM workjet_team_selections WHERE selection_id = ${selection.selectionId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ProjectTeamLearningStore.readSelection")));
      const saved = rows[0];
      if (
        !saved ||
        saved.workerThreadId !== selection.workerThreadId ||
        saved.candidate !== selection.candidate ||
        saved.taskType !== selection.taskType ||
        saved.difficulty !== selection.difficulty ||
        saved.reasoning !== selection.reasoning ||
        saved.randomized !== (selection.randomized ? 1 : 0) ||
        saved.draw !== selection.draw ||
        saved.mode !== selection.mode ||
        saved.selectedAtMillis !== selection.selectedAtMillis
      ) {
        return yield* evidenceError("Team model selection evidence changed on retry");
      }
    }).pipe(
      sql.withTransaction,
      Effect.mapError(transactionError("ProjectTeamLearningStore.recordSelection:transaction")),
    );

  const recordAssessment: ProjectTeamLearningStoreShape["recordAssessment"] = (assessment) =>
    Effect.gen(function* () {
      const { review, selectionId, cause } = assessment;
      const selected = yield* sql<{
        readonly workerThreadId: string;
        readonly taskType: string;
        readonly difficulty: string;
      }>`
        SELECT worker_thread_id AS "workerThreadId", task_type AS "taskType", difficulty
        FROM workjet_team_selections WHERE selection_id = ${selectionId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ProjectTeamLearningStore.assessmentSelection")));
      if (
        selected[0]?.workerThreadId !== review.subjectThreadId ||
        selected[0]?.taskType !== review.taskType ||
        selected[0]?.difficulty !== review.difficulty ||
        review.packageId !== review.subjectThreadId ||
        !Number.isInteger(review.score) ||
        review.score < 0 ||
        review.score > 10
      ) {
        return yield* evidenceError("Review does not match its selected worker");
      }
      const executionJson = JSON.stringify(review.execution);
      const recordedAtMillis = Date.parse(review.recordedAt);
      if (!Number.isSafeInteger(recordedAtMillis) || recordedAtMillis < 0) {
        return yield* evidenceError("Invalid team review timestamp");
      }
      yield* sql`
        INSERT INTO workjet_team_reviews (
          review_id, selection_id, phase, score, cause, reviewer_thread_id,
          subject_thread_id, execution_json, practice, evidence_ref, recorded_at_ms
        ) VALUES (
          ${review.reviewId}, ${selectionId}, ${review.phase}, ${review.score},
          ${cause}, ${review.reviewerThreadId}, ${review.subjectThreadId},
          ${executionJson}, ${review.practice}, ${review.evidenceRef},
          ${recordedAtMillis}
        ) ON CONFLICT DO NOTHING
      `.pipe(Effect.mapError(toPersistenceSqlError("ProjectTeamLearningStore.recordAssessment")));
      const rows = yield* sql<{
        readonly selectionId: string;
        readonly phase: string;
        readonly score: number;
        readonly cause: string;
        readonly reviewerThreadId: string;
        readonly subjectThreadId: string;
        readonly executionJson: string;
        readonly practice: string;
        readonly evidenceRef: string;
        readonly recordedAtMillis: number;
      }>`
        SELECT selection_id AS "selectionId", phase, score, cause,
               reviewer_thread_id AS "reviewerThreadId",
               subject_thread_id AS "subjectThreadId", execution_json AS "executionJson",
               practice, evidence_ref AS "evidenceRef", recorded_at_ms AS "recordedAtMillis"
        FROM workjet_team_reviews WHERE review_id = ${review.reviewId}
      `.pipe(Effect.mapError(toPersistenceSqlError("ProjectTeamLearningStore.readAssessment")));
      const saved = rows[0];
      if (
        !saved ||
        saved.selectionId !== selectionId ||
        saved.phase !== review.phase ||
        saved.score !== review.score ||
        saved.cause !== cause ||
        saved.reviewerThreadId !== review.reviewerThreadId ||
        saved.subjectThreadId !== review.subjectThreadId ||
        saved.executionJson !== executionJson ||
        saved.practice !== review.practice ||
        saved.evidenceRef !== review.evidenceRef ||
        saved.recordedAtMillis !== recordedAtMillis
      ) {
        return yield* evidenceError("Team review evidence changed on retry");
      }
    }).pipe(
      sql.withTransaction,
      Effect.mapError(transactionError("ProjectTeamLearningStore.recordAssessment:transaction")),
    );

  const listObservations: ProjectTeamLearningStoreShape["listObservations"] = (input) =>
    sql<{
      readonly selectionId: string;
      readonly candidate: string;
      readonly taskType: string;
      readonly difficulty: string;
      readonly reasoning: string;
      readonly randomized: number;
      readonly firstScore: number | null;
      readonly cause: "model" | "task_spec" | "unknown" | null;
    }>`
      SELECT s.selection_id AS "selectionId", s.candidate_key AS "candidate",
             s.task_type AS "taskType", s.difficulty, s.reasoning, s.randomized,
             r.score AS "firstScore", r.cause
      FROM workjet_team_selections s
      LEFT JOIN workjet_team_reviews r
        ON r.selection_id = s.selection_id AND r.phase = 'first-delivery'
      WHERE s.task_type = ${input.taskType}
        AND s.difficulty = ${input.difficulty}
        AND s.reasoning = ${input.reasoning}
      ORDER BY s.selected_at_ms, s.selection_id
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectTeamLearningStore.listObservations")),
      Effect.map((rows) =>
        rows.map((row) => ({
          ...row,
          randomized: row.randomized === 1,
          cause: row.cause ?? "unknown",
        })),
      ),
    );

  return ProjectTeamLearningStore.of({ recordSelection, recordAssessment, listObservations });
});

export const layer = Layer.effect(ProjectTeamLearningStore, make);
