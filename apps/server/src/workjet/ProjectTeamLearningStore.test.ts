// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { ThreadId, type WorkjetTeamReview } from "@workjet/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { compareTeamCandidates } from "./ProjectTeamLearning.ts";
import {
  ProjectTeamLearningStore,
  layer,
  type TeamSelectionRecord,
} from "./ProjectTeamLearningStore.ts";

const workerThreadId = ThreadId.make("00000000-0000-4000-8000-00000000000a");
const reviewerThreadId = ThreadId.make("00000000-0000-4000-8000-00000000000b");
const selection: TeamSelectionRecord = {
  selectionId: "selection-a",
  workerThreadId,
  candidate: "provider/model/harness/1",
  taskType: "backend",
  difficulty: "standard",
  reasoning: "high",
  randomized: true,
  draw: 0.375,
  mode: "uniform",
  selectedAtMillis: 1_700_000_000_000,
};
const review: WorkjetTeamReview = {
  reviewId: "review-a",
  packageId: workerThreadId,
  reviewerThreadId,
  subjectThreadId: workerThreadId,
  execution: {
    providerInstanceId: "provider",
    model: "model",
    harness: "harness",
    harnessVersion: "1",
  },
  taskType: "backend",
  difficulty: "standard",
  phase: "first-delivery",
  score: 8,
  practice: "Repeat the bounded change and focused verification.",
  evidenceRef: "https://example.test/pull/7",
  recordedAt: "2023-11-14T22:13:20.000Z",
};

const withDatabase = <A, E>(
  effect: Effect.Effect<A, E, ProjectTeamLearningStore | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))));

describe("ProjectTeamLearningStore", () => {
  it.effect(
    "retains the randomized assignment as unassessed until a first delivery is scored",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* runMigrations();
          const store = yield* ProjectTeamLearningStore;
          yield* store.recordSelection(selection);
          yield* store.recordSelection(selection);
          const before = yield* store.listObservations(selection);
          assert.equal(before.length, 1);
          assert.equal(before[0]?.firstScore, null);
          assert.equal(
            compareTeamCandidates({
              candidates: [selection.candidate, "another/model/harness/1"],
              observations: before,
              ...selection,
            }).rows.find((row) => row.candidate === selection.candidate)?.unassessed,
            1,
          );

          yield* store.recordAssessment({
            selectionId: selection.selectionId,
            review,
            cause: "model",
          });
          yield* store.recordAssessment({
            selectionId: selection.selectionId,
            review,
            cause: "model",
          });
          const after = yield* store.listObservations(selection);
          assert.equal(after.length, 1);
          assert.equal(after[0]?.firstScore, 8);
          assert.equal(after[0]?.cause, "model");
        }),
      ),
  );

  it.effect("rejects substituted assignments and reviews while keeping the original evidence", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* runMigrations();
        const store = yield* ProjectTeamLearningStore;
        yield* store.recordSelection(selection);
        assert.equal(
          (yield* Effect.exit(store.recordSelection({ ...selection, candidate: "other" })))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(
            store.recordAssessment({
              selectionId: selection.selectionId,
              review: { ...review, subjectThreadId: reviewerThreadId },
              cause: "model",
            }),
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(
            store.recordAssessment({
              selectionId: selection.selectionId,
              review: { ...review, difficulty: "hard" },
              cause: "model",
            }),
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(
            store.recordAssessment({
              selectionId: selection.selectionId,
              review: { ...review, execution: { ...review.execution, model: "other-model" } },
              cause: "model",
            }),
          ))._tag,
          "Failure",
        );
        yield* store.recordAssessment({
          selectionId: selection.selectionId,
          review,
          cause: "model",
        });
        assert.equal(
          (yield* Effect.exit(
            store.recordAssessment({
              selectionId: selection.selectionId,
              review: { ...review, score: 1 },
              cause: "model",
            }),
          ))._tag,
          "Failure",
        );
        assert.equal((yield* store.listObservations(selection))[0]?.firstScore, 8);
      }),
    ),
  );
});
