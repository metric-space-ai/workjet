// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { WorkerRunLedger, layer as ledgerLayer } from "../workjet/WorkerRunLedger.ts";
import { WorkerRunAssessments, layer as assessmentLayer } from "../workjet/WorkerRunAssessment.ts";
import { layer as drawLayer } from "../workjet/WorkerRunDraw.ts";
import { parseWorkerAssessment, readWorkerLedgerRun } from "./workerLedger.ts";

it.effect("accepts bounded scores and keeps omitted assessments backward compatible", () =>
  Effect.gen(function* () {
    assert.equal(yield* parseWorkerAssessment({ rework: "none", cause: "unknown" }), undefined);
    assert.equal(
      (yield* parseWorkerAssessment({ score: "unassessed", rework: "none", cause: "quota" }))
        ?.score,
      "unassessed",
    );
    assert.equal(
      (yield* parseWorkerAssessment({
        score: "8.5",
        rework: "small",
        cause: "model",
        note: " Validated first delivery. ",
      }))?.score,
      8.5,
    );
    for (const score of ["-1", "11", "NaN", "excellent"])
      assert.equal(
        (yield* Effect.exit(parseWorkerAssessment({ score, rework: "none", cause: "unknown" })))
          ._tag,
        "Failure",
      );
  }),
);
it.effect("shows the durable run and assessments, and rejects a missing run", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const ledger = yield* WorkerRunLedger;
    const at = "2026-10-13T09:00:00.000Z";
    yield* ledger.queue(
      {
        runId: "fixture-worker",
        parent: { threadId: null, sessionId: null, model: null, harness: null },
        worker: { model: null, harness: null, providerRoute: null, reasoning: null },
        briefSha256: "a".repeat(64),
        taskType: "backend",
        difficulty: "standard",
        selection: "manual",
      },
      at,
    );
    yield* ledger.observe({ runId: "fixture-worker", terminalAt: at });
    yield* (yield* WorkerRunAssessments).mark({
      runId: "fixture-worker",
      disposition: "abandoned",
      recordedAt: at,
    });
    const result = yield* readWorkerLedgerRun("fixture-worker");
    assert.equal(result.disposition, "abandoned");
    assert.deepEqual(result.assessments, []);
    assert.equal(result.draw, null);
    assert.equal((yield* Effect.exit(readWorkerLedgerRun("missing")))._tag, "Failure");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ledgerLayer, assessmentLayer, drawLayer).pipe(
        Layer.provideMerge(NodeSqliteClient.layerMemory()),
      ),
    ),
  ),
);
