// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { IsoDateTime } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { WorkerRunLedgerError } from "./WorkerRunLedger.ts";

export const WorkerRunAssessment = Schema.Struct({
  score: Schema.Union([
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10)),
    Schema.Literal("unassessed"),
  ]),
  rework: Schema.Literals(["none", "small", "substantial", "parent_takeover"]),
  cause: Schema.Literals(["model", "task_spec", "tooling", "environment", "quota", "unknown"]),
  note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
});
export type WorkerRunAssessment = typeof WorkerRunAssessment.Type;
const jsonSchema = Schema.fromJsonString(WorkerRunAssessment);
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mark = Effect.fn("WorkerRunAssessment.mark")(
    function* (input: {
      readonly runId: string;
      readonly disposition: "integrated" | "abandoned";
      readonly assessment?: WorkerRunAssessment;
      readonly final?: boolean;
      readonly recordedAt: string;
    }) {
      yield* Schema.decodeUnknownEffect(IsoDateTime)(input.recordedAt);
      const phase = input.final ? "final" : "first";
      const json =
        input.assessment === undefined
          ? null
          : yield* Schema.encodeEffect(jsonSchema)(input.assessment);
      if (input.assessment?.cause === "quota" && input.assessment.score !== "unassessed")
        return yield* new WorkerRunLedgerError({ detail: "Quota failure must remain unassessed" });
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const runs = yield* sql<{
            readonly disposition: string | null;
            readonly terminalAt: string | null;
            readonly abortClass: string;
          }>`
        SELECT disposition, terminal_at AS "terminalAt", abort_class AS "abortClass" FROM workjet_worker_runs WHERE run_id = ${input.runId}`;
          const run = runs[0];
          if (!run || run.terminalAt === null)
            return yield* new WorkerRunLedgerError({ detail: "Worker run is not terminal" });
          if (
            run.abortClass === "quota" &&
            input.assessment !== undefined &&
            input.assessment.score !== "unassessed"
          )
            return yield* new WorkerRunLedgerError({
              detail: "Quota failure must remain unassessed",
            });
          if (run.disposition !== null && run.disposition !== input.disposition)
            return yield* new WorkerRunLedgerError({ detail: "Worker disposition is immutable" });
          if (json !== null) {
            if (phase === "final") {
              const first =
                yield* sql`SELECT 1 FROM workjet_worker_run_assessments WHERE run_id = ${input.runId} AND phase = 'first'`;
              if (!first.length)
                return yield* new WorkerRunLedgerError({
                  detail: "Final assessment requires a first assessment",
                });
            }
            yield* sql`INSERT INTO workjet_worker_run_assessments (run_id, phase, assessment_json, recorded_at)
          VALUES (${input.runId}, ${phase}, ${json}, ${input.recordedAt}) ON CONFLICT(run_id, phase) DO NOTHING`;
            const previous = yield* sql<{ readonly json: string }>`SELECT assessment_json AS "json"
          FROM workjet_worker_run_assessments WHERE run_id = ${input.runId} AND phase = ${phase}`;
            if (previous[0]?.json !== json)
              return yield* new WorkerRunLedgerError({ detail: "Worker assessment is immutable" });
          }
          yield* sql`UPDATE workjet_worker_runs SET disposition = ${input.disposition} WHERE run_id = ${input.runId}`;
        }),
      );
      return { warning: input.assessment?.note?.trim() ? null : "No assessment note supplied" };
    },
    Effect.mapError((cause) =>
      Schema.is(WorkerRunLedgerError)(cause)
        ? cause
        : toPersistenceSqlError("WorkerRunAssessment.mark")(cause),
    ),
  );
  const list = Effect.fn("WorkerRunAssessment.list")(
    function* (runId: string) {
      const rows = yield* sql<{
        readonly phase: "first" | "final";
        readonly json: string;
        readonly recordedAt: string;
      }>`
      SELECT phase, assessment_json AS "json", recorded_at AS "recordedAt"
      FROM workjet_worker_run_assessments WHERE run_id = ${runId} ORDER BY recorded_at, phase`;
      return yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(jsonSchema)(row.json).pipe(
          Effect.map((value) => ({ ...value, phase: row.phase, recordedAt: row.recordedAt })),
        ),
      );
    },
    Effect.mapError(toPersistenceSqlError("WorkerRunAssessment.list")),
  );
  return { mark, list };
});
export class WorkerRunAssessments extends Context.Service<
  WorkerRunAssessments,
  Effect.Success<typeof make>
>()("workjet/workjet/WorkerRunAssessment/WorkerRunAssessments") {}
export const layer = Layer.effect(WorkerRunAssessments, make);
