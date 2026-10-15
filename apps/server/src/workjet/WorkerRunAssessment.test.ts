// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { WorkerRunLedger, layer as ledgerLayer } from "./WorkerRunLedger.ts";
import { WorkerRunAssessments, layer, make } from "./WorkerRunAssessment.ts";

const at = "2026-10-13T09:00:00.000Z";
const identity = {
  runId: "fixture-worker",
  parent: { threadId: "parent", sessionId: null, model: null, harness: null },
  worker: { model: null, harness: null, providerRoute: null, reasoning: null },
  briefSha256: "a".repeat(64),
  taskType: "backend",
  difficulty: "standard",
  selection: "manual",
} as const;
const assessment = {
  score: 8,
  rework: "small",
  cause: "unknown",
  note: "The accepted change passed its focused checks.",
} as const;
const database = <A, E>(
  effect: Effect.Effect<A, E, WorkerRunLedger | WorkerRunAssessments | SqlClient.SqlClient>,
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(layer, ledgerLayer).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
    ),
  );
describe("worker completion assessment", () => {
  it.effect("retains first delivery and final assessment independently across reconstruction", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        const ledger = yield* WorkerRunLedger;
        const scores = yield* WorkerRunAssessments;
        yield* ledger.queue(identity, at);
        assert.equal(
          (yield* Effect.exit(
            scores.mark({
              runId: identity.runId,
              disposition: "integrated",
              assessment,
              recordedAt: at,
            }),
          ))._tag,
          "Failure",
        );
        yield* ledger.observe({ runId: identity.runId, terminalAt: at });
        const input = {
          runId: identity.runId,
          disposition: "integrated",
          assessment,
          recordedAt: at,
        } as const;
        yield* scores.mark(input);
        yield* scores.mark(input);
        assert.equal(
          (yield* Effect.exit(scores.mark({ ...input, assessment: { ...assessment, score: 2 } })))
            ._tag,
          "Failure",
        );
        yield* scores.mark({ ...input, final: true, assessment: { ...assessment, score: 9 } });
        assert.deepEqual(
          (yield* (yield* make).list(identity.runId)).map((row) => row.score),
          [9, 8],
        );
      }),
    ),
  );
  it.effect("warns without breaking old unscored marks and never grades quota failure", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        const ledger = yield* WorkerRunLedger;
        const scores = yield* WorkerRunAssessments;
        yield* ledger.queue(identity, at);
        yield* ledger.observe({ runId: identity.runId, terminalAt: at, abortClass: "quota" });
        const input = { runId: identity.runId, disposition: "abandoned", recordedAt: at } as const;
        assert.equal((yield* scores.mark(input)).warning, "No assessment note supplied");
        assert.equal(
          (yield* Effect.exit(
            scores.mark({ ...input, assessment: { ...assessment, cause: "quota" } }),
          ))._tag,
          "Failure",
        );
        assert.equal((yield* Effect.exit(scores.mark({ ...input, assessment })))._tag, "Failure");
        yield* scores.mark({
          ...input,
          assessment: { ...assessment, cause: "quota", score: "unassessed" },
        });
        assert.equal((yield* scores.list(identity.runId))[0]?.score, "unassessed");
      }),
    ),
  );
});
