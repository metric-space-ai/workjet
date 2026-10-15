// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { IsoDateTime } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

export const WorkerTaskType = Schema.Literals([
  "backend",
  "ui",
  "security",
  "tests",
  "refactor",
  "devops",
  "docs",
  "other",
]);
export const WorkerDifficulty = Schema.Literals(["small", "standard", "hard"]);
export const WorkerAbortClass = Schema.Literals([
  "auth",
  "quota",
  "transport",
  "timeout",
  "task",
  "none",
]);
const optionalFact = Schema.NullOr(Schema.NonEmptyString);
export const WorkerRunIdentity = Schema.Struct({
  runId: Schema.NonEmptyString,
  parent: Schema.Struct({
    threadId: optionalFact,
    sessionId: optionalFact,
    model: optionalFact,
    harness: optionalFact,
  }),
  worker: Schema.Struct({
    model: optionalFact,
    harness: optionalFact,
    providerRoute: optionalFact,
    reasoning: optionalFact,
  }),
  briefSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  taskType: WorkerTaskType,
  difficulty: WorkerDifficulty,
  selection: Schema.Literals(["manual", "pool"]),
});
export type WorkerRunIdentity = typeof WorkerRunIdentity.Type;
export const WorkerRunExecution = Schema.Struct({
  model: optionalFact,
  harness: Schema.NonEmptyString,
  providerRoute: optionalFact,
  reasoning: optionalFact,
});
export const WorkerRunProgress = Schema.Struct({
  runId: Schema.NonEmptyString,
  startedAt: Schema.optional(IsoDateTime),
  execution: Schema.optional(WorkerRunExecution),
  firstOutputAt: Schema.optional(IsoDateTime),
  terminalAt: Schema.optional(IsoDateTime),
  abortClass: Schema.optional(WorkerAbortClass),
  resultCommit: Schema.optional(
    Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  ),
});
export type WorkerRunProgress = typeof WorkerRunProgress.Type;
export interface WorkerRunRecord extends WorkerRunIdentity {
  readonly execution: typeof WorkerRunExecution.Type | null;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly firstOutputAt: string | null;
  readonly terminalAt: string | null;
  readonly abortClass: typeof WorkerAbortClass.Type;
  readonly resultCommit: string | null;
  readonly disposition: "integrated" | "abandoned" | null;
  readonly pullRequest: {
    readonly provider: string;
    readonly number: number;
    readonly url: string;
    readonly headOid: string;
  } | null;
}
export class WorkerRunLedgerError extends Schema.TaggedErrorClass<WorkerRunLedgerError>()(
  "WorkerRunLedgerError",
  { detail: Schema.String },
) {}
const identityJson = Schema.fromJsonString(WorkerRunIdentity);
const encodeIdentity = Schema.encodeEffect(identityJson);
const decodeIdentity = Schema.decodeUnknownEffect(identityJson);
const validateProgress = Schema.decodeUnknownEffect(WorkerRunProgress);
const invalid = (detail: string) => new WorkerRunLedgerError({ detail });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queue = Effect.fn("WorkerRunLedger.queue")(
    function* (identity: WorkerRunIdentity, queuedAt: string) {
      const json = yield* encodeIdentity(identity);
      yield* Schema.decodeUnknownEffect(IsoDateTime)(queuedAt);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO workjet_worker_runs (run_id, identity_json, queued_at)
        VALUES (${identity.runId}, ${json}, ${queuedAt}) ON CONFLICT(run_id) DO NOTHING`;
          const rows = yield* sql<{ readonly identityJson: string; readonly queuedAt: string }>`
        SELECT identity_json AS "identityJson", queued_at AS "queuedAt"
        FROM workjet_worker_runs WHERE run_id = ${identity.runId}`;
          if (rows[0]?.identityJson !== json || rows[0]?.queuedAt !== queuedAt)
            return yield* invalid("Worker run identity changed on retry");
        }),
      );
    },
    Effect.mapError((cause) =>
      Schema.is(WorkerRunLedgerError)(cause)
        ? cause
        : toPersistenceSqlError("WorkerRunLedger.queue")(cause),
    ),
  );
  const observe = Effect.fn("WorkerRunLedger.observe")(
    function* (input: WorkerRunProgress) {
      const value = yield* validateProgress(input);
      const executionJson =
        value.execution === undefined
          ? null
          : yield* Schema.encodeEffect(Schema.fromJsonString(WorkerRunExecution))(value.execution);
      // Event replay fills only previously unknown milestones. A late event cannot reopen a run.
      yield* sql`UPDATE workjet_worker_runs SET
      started_at = COALESCE(started_at, ${value.startedAt ?? null}),
      first_output_at = COALESCE(first_output_at, ${value.firstOutputAt ?? null}),
      abort_class = CASE WHEN terminal_at IS NOT NULL THEN abort_class
        WHEN ${value.terminalAt ?? null} IS NOT NULL AND ${value.abortClass ?? null} = 'task' AND abort_class != 'none' THEN abort_class
        ELSE COALESCE(${value.abortClass ?? null}, abort_class) END,
      execution_json = COALESCE(execution_json, ${executionJson}),
      terminal_at = COALESCE(terminal_at, ${value.terminalAt ?? null}),
      result_commit = COALESCE(result_commit, ${value.resultCommit ?? null})
      WHERE run_id = ${value.runId} AND (
        (${value.startedAt ?? null} IS NOT NULL AND started_at IS NULL) OR
        (${value.firstOutputAt ?? null} IS NOT NULL AND first_output_at IS NULL) OR
        (${executionJson} IS NOT NULL AND execution_json IS NULL) OR
        (${value.terminalAt ?? null} IS NOT NULL AND terminal_at IS NULL) OR
        (${value.resultCommit ?? null} IS NOT NULL AND result_commit IS NULL) OR
        (${value.abortClass ?? null} IS NOT NULL AND terminal_at IS NULL AND abort_class != ${value.abortClass ?? null})
      )`;
    },
    Effect.mapError(toPersistenceSqlError("WorkerRunLedger.observe")),
  );
  const read = Effect.fn("WorkerRunLedger.read")(
    function* (runId: string | null) {
      const rows = yield* sql<{
        readonly identityJson: string;
        readonly executionJson: string | null;
        readonly queuedAt: string;
        readonly startedAt: string | null;
        readonly firstOutputAt: string | null;
        readonly terminalAt: string | null;
        readonly abortClass: typeof WorkerAbortClass.Type;
        readonly resultCommit: string | null;
        readonly disposition: WorkerRunRecord["disposition"];
        readonly provider: string | null;
        readonly number: number | null;
        readonly url: string | null;
        readonly headOid: string | null;
      }>`SELECT r.identity_json AS "identityJson", r.execution_json AS "executionJson", r.queued_at AS "queuedAt",
      r.started_at AS "startedAt", r.first_output_at AS "firstOutputAt", r.terminal_at AS "terminalAt",
      r.abort_class AS "abortClass", COALESCE(r.result_commit, p.head_oid) AS "resultCommit", r.disposition,
      p.provider, p.pr_number AS "number", p.pr_url AS "url", p.head_oid AS "headOid"
      FROM workjet_worker_runs r LEFT JOIN workjet_worker_pull_requests p ON p.thread_id = r.run_id
      WHERE (${runId ?? null} IS NULL OR r.run_id = ${runId ?? null}) ORDER BY r.queued_at, r.run_id`;
      return yield* Effect.forEach(rows, (row) =>
        decodeIdentity(row.identityJson).pipe(
          Effect.map(
            (identity): WorkerRunRecord => ({
              ...identity,
              execution:
                row.executionJson === null
                  ? null
                  : Schema.decodeUnknownSync(Schema.fromJsonString(WorkerRunExecution))(
                      row.executionJson,
                    ),
              queuedAt: row.queuedAt,
              startedAt: row.startedAt,
              firstOutputAt: row.firstOutputAt,
              terminalAt: row.terminalAt,
              abortClass: row.abortClass,
              resultCommit: row.resultCommit,
              disposition: row.disposition,
              pullRequest:
                row.provider !== null &&
                row.number !== null &&
                row.url !== null &&
                row.headOid !== null
                  ? {
                      provider: row.provider,
                      number: row.number,
                      url: row.url,
                      headOid: row.headOid,
                    }
                  : null,
            }),
          ),
        ),
      );
    },
    Effect.mapError(toPersistenceSqlError("WorkerRunLedger.read")),
  );
  return {
    queue,
    observe,
    list: () => read(null),
    get: (runId: string) => read(runId).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]))),
  };
});
export class WorkerRunLedger extends Context.Service<
  WorkerRunLedger,
  Effect.Success<typeof make>
>()("workjet/workjet/WorkerRunLedger") {}
export const layer = Layer.effect(WorkerRunLedger, make);
