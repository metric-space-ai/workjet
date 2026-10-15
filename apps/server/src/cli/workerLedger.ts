// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import * as ServerConfig from "../config.ts";
import { layerConfig as persistenceLayer } from "../persistence/Layers/Sqlite.ts";
import {
  WorkerRunLedger,
  WorkerRunLedgerError,
  layer as ledgerLayer,
} from "../workjet/WorkerRunLedger.ts";
import {
  WorkerRunAssessments,
  layer as assessmentLayer,
  type WorkerRunAssessment,
} from "../workjet/WorkerRunAssessment.ts";
import { WorkerRunDraw, layer as drawLayer } from "../workjet/WorkerRunDraw.ts";
import { projectLocationFlags, resolveCliAuthConfig, type CliAuthLocationFlags } from "./config.ts";

const runtimeLayer = Layer.mergeAll(ledgerLayer, assessmentLayer, drawLayer).pipe(
  Layer.provideMerge(persistenceLayer),
);
const withLedger = Effect.fn("cli.workerLedger.withLedger")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: Effect.Effect<A, E, R | WorkerRunLedger | WorkerRunAssessments | WorkerRunDraw>,
) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  return yield* run.pipe(
    Effect.provide(runtimeLayer.pipe(Layer.provide(ServerConfig.layer(config)))),
  );
});
const printJson = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.flatMap(Console.log),
  );
export const readWorkerLedgerRun = Effect.fn("cli.workerLedger.show")(function* (runId: string) {
  const ledger = yield* WorkerRunLedger;
  const scores = yield* WorkerRunAssessments;
  const draws = yield* WorkerRunDraw;
  const result = yield* ledger.get(runId);
  if (Option.isNone(result))
    return yield* new WorkerRunLedgerError({ detail: "Worker run not found" });
  return {
    ...result.value,
    assessments: yield* scores.list(runId),
    draw:
      result.value.selection === "pool"
        ? Option.getOrNull(yield* draws.get(result.value.briefSha256))
        : null,
  };
});
const scoreInput = Schema.Union([
  Schema.Literal("unassessed"),
  Schema.NumberFromString.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10)),
]);
export const parseWorkerAssessment = Effect.fn("cli.workerLedger.parseAssessment")(
  function* (input: {
    readonly score?: string | undefined;
    readonly note?: string | undefined;
    readonly rework: WorkerRunAssessment["rework"];
    readonly cause: WorkerRunAssessment["cause"];
  }) {
    if (
      input.score === undefined &&
      input.note === undefined &&
      input.rework === "none" &&
      input.cause === "unknown"
    )
      return undefined;
    return {
      score:
        input.score === undefined
          ? ("unassessed" as const)
          : yield* Schema.decodeUnknownEffect(scoreInput)(input.score),
      rework: input.rework,
      cause: input.cause,
      note: input.note?.trim() || null,
    };
  },
);
const common = {
  ...projectLocationFlags,
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
};
export const ledgerCommand = Command.make("ledger").pipe(
  Command.withSubcommands([
    Command.make("list", common).pipe(
      Command.withHandler((flags) =>
        withLedger(
          flags,
          Effect.gen(function* () {
            const rows = yield* (yield* WorkerRunLedger).list();
            if (flags.json) yield* printJson(rows);
            else
              for (const row of rows)
                yield* Console.log(
                  `${row.runId} ${row.disposition ?? (row.terminalAt === null ? "active" : "terminal")} ${row.selection}`,
                );
          }),
        ),
      ),
    ),
    Command.make("show", { ...common, runId: Argument.string("run") }).pipe(
      Command.withHandler((flags) =>
        withLedger(flags, readWorkerLedgerRun(flags.runId).pipe(Effect.flatMap(printJson))),
      ),
    ),
  ]),
);
export const runsCommand = Command.make("runs").pipe(
  Command.withSubcommands([
    Command.make("mark", {
      ...common,
      runId: Argument.string("run"),
      disposition: Argument.choice("disposition", ["integrated", "abandoned"]),
      score: Flag.string("score").pipe(Flag.optional),
      note: Flag.string("note").pipe(Flag.optional),
      rework: Flag.choice("rework", ["none", "small", "substantial", "parent_takeover"]).pipe(
        Flag.withDefault("none"),
      ),
      cause: Flag.choice("cause", [
        "model",
        "task_spec",
        "tooling",
        "environment",
        "quota",
        "unknown",
      ]).pipe(Flag.withDefault("unknown")),
      final: Flag.boolean("final").pipe(Flag.withDefault(false)),
    }).pipe(
      Command.withHandler((flags) =>
        withLedger(
          flags,
          Effect.gen(function* () {
            const assessment = yield* parseWorkerAssessment({
              ...flags,
              score: Option.getOrUndefined(flags.score),
              note: Option.getOrUndefined(flags.note),
            });
            if (flags.final && assessment === undefined)
              return yield* new WorkerRunLedgerError({
                detail: "Final assessment requires assessment fields",
              });
            const result = yield* (yield* WorkerRunAssessments).mark({
              runId: flags.runId,
              disposition: flags.disposition,
              ...(assessment === undefined ? {} : { assessment }),
              final: flags.final,
              recordedAt: DateTime.formatIso(yield* DateTime.now),
            });
            if (result.warning) yield* Console.warn(result.warning);
            yield* readWorkerLedgerRun(flags.runId).pipe(Effect.flatMap(printJson));
          }),
        ),
      ),
    ),
  ]),
);
