// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Config from "effect/Config";
import * as Console from "effect/Console";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { normalizeCtoxMcpEndpoint } from "../workjet/ctox/CtoxMcpTransport.ts";
import { workerRunToolRequest } from "./workerRunClient.ts";
import { WorkerRunLedgerError } from "../workjet/WorkerRunLedger.ts";

/** Uses the existing provider-scoped MCP bearer; never reads an app credential file. */
export const callWorkerTool = Effect.fn("cli.workerRun.callTool")(function* (
  url: string,
  name: string,
  input: Readonly<Record<string, unknown>>,
) {
  const token = yield* Config.string("WORKJET_MCP_BEARER_TOKEN");
  const endpoint = yield* normalizeCtoxMcpEndpoint(url);
  const result = yield* workerRunToolRequest({ endpoint, token }, name, input);
  if (result.isError && result.structuredContent !== undefined)
    yield* Console.error(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result.structuredContent),
    );
  if (result.isError || result.structuredContent === undefined)
    return yield* new WorkerRunLedgerError({
      detail:
        "Worker command rejected; use an active orchestrator MCP session and inspect the saved run before retrying",
    });
  yield* Console.log(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result.structuredContent),
  );
}, Effect.provide(FetchHttpClient.layer));
const connectionFlags = {
  url: Flag.string("url").pipe(
    Flag.withDescription("The Workjet MCP endpoint from the current orchestrator session."),
  ),
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
};
export const workersCommand = Command.make("workers").pipe(
  Command.withSubcommands([
    Command.make("list", connectionFlags).pipe(
      Command.withHandler((flags) => callWorkerTool(flags.url, "workjet_workers_list", {})),
    ),
  ]),
);
export const healthCommand = Command.make("health", {
  ...connectionFlags,
  probeWorkers: Flag.boolean("probe-workers").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withHandler((flags) =>
    callWorkerTool(
      flags.url,
      flags.probeWorkers ? "workjet_worker_health" : "workjet_workers_list",
      {},
    ),
  ),
);
export const runCommand = Command.make("run", {
  ...connectionFlags,
  worker: Argument.string("worker").pipe(Argument.optional),
  pool: Flag.choice("pool", ["worker"]).pipe(Flag.optional),
  remoteRequestId: Flag.string("remote-request-id").pipe(Flag.optional),
  brief: Flag.string("brief").pipe(Flag.optional),
  briefFile: Flag.string("brief-file").pipe(Flag.optional),
  taskType: Flag.choice("task-type", [
    "backend",
    "ui",
    "security",
    "tests",
    "refactor",
    "devops",
    "docs",
    "other",
  ]).pipe(Flag.withDefault("other")),
  difficulty: Flag.choice("difficulty", ["small", "standard", "hard"]).pipe(
    Flag.withDefault("standard"),
  ),
}).pipe(
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (
        Option.isSome(flags.worker) === Option.isSome(flags.pool) ||
        Option.isSome(flags.brief) === Option.isSome(flags.briefFile)
      )
        return yield* new WorkerRunLedgerError({
          detail: "Choose one worker name or --pool worker, and one --brief or --brief-file",
        });
      const task = Option.isSome(flags.brief)
        ? flags.brief.value
        : yield* (yield* FileSystem.FileSystem).readFileString(Option.getOrThrow(flags.briefFile));
      if (!task.trim() || task.length > 32_000)
        return yield* new WorkerRunLedgerError({
          detail: "Worker brief must contain 1–32000 characters",
        });
      yield* callWorkerTool(flags.url, "workjet_dispatch_worker", {
        task,
        taskType: flags.taskType,
        difficulty: flags.difficulty,
        ...(Option.isSome(flags.remoteRequestId)
          ? { remoteRequestId: flags.remoteRequestId.value }
          : {}),
        ...(Option.isSome(flags.pool)
          ? { pool: flags.pool.value }
          : { workerName: Option.getOrThrow(flags.worker) }),
      });
    }),
  ),
);
