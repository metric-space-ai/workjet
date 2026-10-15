// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { IsoDateTime } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { drawTeamCandidate } from "./ProjectTeamLearning.ts";
import { WorkerRunLedgerError } from "./WorkerRunLedger.ts";

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const WorkerRunDrawReceipt = Schema.Struct({
  briefSha256: digest,
  healthSnapshotSha256: digest,
  observedAt: IsoDateTime,
  strategy: Schema.Literal("uniform"),
  candidates: Schema.Array(
    Schema.Struct({ candidate: Schema.NonEmptyString, probability: Schema.Number }),
  ),
  randomValue: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(1)),
  selected: Schema.NonEmptyString,
});
export type WorkerRunDrawReceipt = typeof WorkerRunDrawReceipt.Type;
/** Candidates are qualified canonical model/route keys, not a worker-profile inventory. */
export interface QualifiedWorkerPool {
  readonly candidates: ReadonlyArray<string>;
  readonly healthSnapshotSha256: string;
  readonly observedAt: string;
}
/** A later strategy can consume learning observations without changing the receipt identity. */
export type WorkerSelectionStrategy = "uniform" | "thompson";
const jsonSchema = Schema.fromJsonString(WorkerRunDrawReceipt);
const invalid = (detail: string) => new WorkerRunLedgerError({ detail });
export const makeWithRandom = (randomValue: Effect.Effect<number>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const get = Effect.fn("WorkerRunDraw.get")(
      function* (briefSha256: string) {
        const rows = yield* sql<{
          readonly json: string;
        }>`SELECT draw_json AS "json" FROM workjet_worker_run_draws WHERE brief_sha256 = ${briefSha256}`;
        return rows[0]
          ? Option.some(yield* Schema.decodeUnknownEffect(jsonSchema)(rows[0].json))
          : Option.none<WorkerRunDrawReceipt>();
      },
      Effect.mapError(toPersistenceSqlError("WorkerRunDraw.get")),
    );
    const select = Effect.fn("WorkerRunDraw.select")(
      function* (input: {
        readonly briefSha256: string;
        readonly pool: QualifiedWorkerPool;
        readonly strategy?: WorkerSelectionStrategy;
      }) {
        yield* Schema.decodeUnknownEffect(digest)(input.briefSha256);
        const prior = yield* get(input.briefSha256);
        if (Option.isSome(prior)) return prior.value;
        if ((input.strategy ?? "uniform") !== "uniform")
          return yield* invalid("Selection strategy is not available yet");
        const draw = drawTeamCandidate({
          available: input.pool.candidates,
          winner: null,
          draw: yield* randomValue,
        });
        if (!draw) return yield* invalid("Official reachable coding-model pool is unavailable");
        const value: WorkerRunDrawReceipt = {
          briefSha256: input.briefSha256,
          healthSnapshotSha256: input.pool.healthSnapshotSha256,
          observedAt: input.pool.observedAt,
          strategy: "uniform",
          candidates: draw.probabilities,
          randomValue: draw.draw,
          selected: draw.candidate,
        };
        const json = yield* Schema.encodeEffect(jsonSchema)(value);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO workjet_worker_run_draws (brief_sha256, draw_json)
        VALUES (${input.briefSha256}, ${json}) ON CONFLICT(brief_sha256) DO NOTHING`;
            const committed = yield* get(input.briefSha256);
            if (Option.isNone(committed)) return yield* invalid("Worker draw was not persisted");
            return committed.value;
          }),
        );
      },
      Effect.mapError((cause) =>
        Schema.is(WorkerRunLedgerError)(cause)
          ? cause
          : toPersistenceSqlError("WorkerRunDraw.select")(cause),
      ),
    );
    return { get, select };
  });
export const make = makeWithRandom(Random.next);
export class WorkerRunDraw extends Context.Service<WorkerRunDraw, Effect.Success<typeof make>>()(
  "workjet/workjet/WorkerRunDraw",
) {}
export const layer = Layer.effect(WorkerRunDraw, make);
