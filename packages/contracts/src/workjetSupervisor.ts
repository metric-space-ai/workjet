import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Identity = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const WorkjetSupervisorThreadId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  Schema.makeFilter((value) => value !== "00000000-0000-0000-0000-000000000000" || "Use a real thread UUID."),
);
export const WorkjetSupervisorGoal = TrimmedNonEmptyString.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter((value) =>
    !value.includes("\0") && new TextEncoder().encode(value).byteLength <= 4096
      ? true
      : "A native supervisor goal must fit in 4096 UTF-8 bytes and contain no NUL.",
  ),
);
export const WorkjetSupervisorBinding = Schema.Struct({
  contract: Schema.Literal("ctox.workjet.supervisor_binding.v1"),
  projectId: ProjectId,
  threadId: WorkjetSupervisorThreadId,
  threadKey: Identity,
}).check(Schema.makeFilter((binding) =>
  binding.threadKey === `business-os/threads/${binding.threadId}` || "Supervisor thread key does not match its UUID.",
));
export type WorkjetSupervisorBinding = typeof WorkjetSupervisorBinding.Type;

/** Native task facts only. This DTO does not expose a run id or an event page. */
export const WorkjetSupervisorTurn = Schema.Struct({
  commandId: Identity,
  taskId: Schema.NullOr(Identity),
  threadId: WorkjetSupervisorThreadId,
  threadKey: Identity,
  executionPhase: Identity,
  status: Identity,
  queueStatus: Schema.NullOr(Identity),
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  terminal: Schema.Boolean,
  result: Schema.Unknown,
  resultTruncated: Schema.Boolean,
  errorCode: Schema.NullOr(Identity),
  errorMessage: Schema.NullOr(Schema.String),
}).check(Schema.makeFilter((turn) =>
  turn.threadKey === `business-os/threads/${turn.threadId}` &&
  turn.terminal === (turn.executionPhase === "terminal")
    ? true
    : "Native supervisor turn has inconsistent thread or terminal facts.",
));
export type WorkjetSupervisorTurn = typeof WorkjetSupervisorTurn.Type;

/** A durable submission intent, saved before dispatch. It grants no native authority. */
export const WorkjetSupervisorTurnIntent = Schema.Struct({
  instanceId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  projectId: ProjectId,
  threadId: WorkjetSupervisorThreadId,
  commandId: CommandId.check(Schema.isMaxLength(120)),
  goal: WorkjetSupervisorGoal,
  createdAt: IsoDateTime,
});
export type WorkjetSupervisorTurnIntent = typeof WorkjetSupervisorTurnIntent.Type;

export const WorkjetSupervisorJournal = Schema.Struct({
  intent: WorkjetSupervisorTurnIntent,
  turn: Schema.NullOr(WorkjetSupervisorTurn),
}).check(Schema.makeFilter((journal) =>
  journal.turn === null || journal.turn.threadId === journal.intent.threadId
    ? true : "The observed native turn belongs to another submission intent.",
));
export type WorkjetSupervisorJournal = typeof WorkjetSupervisorJournal.Type;
