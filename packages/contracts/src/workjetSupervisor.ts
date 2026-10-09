import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Identity = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const WorkjetSupervisorThreadId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  Schema.makeFilter(
    (value) => value !== "00000000-0000-0000-0000-000000000000" || "Use a real thread UUID.",
  ),
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
}).check(
  Schema.makeFilter(
    (binding) =>
      binding.threadKey === `business-os/threads/${binding.threadId}` ||
      "Supervisor thread key does not match its UUID.",
  ),
);
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
}).check(
  Schema.makeFilter((turn) =>
    turn.threadKey === `business-os/threads/${turn.threadId}` &&
    turn.terminal === (turn.executionPhase === "terminal")
      ? true
      : "Native supervisor turn has inconsistent thread or terminal facts.",
  ),
);
export type WorkjetSupervisorTurn = typeof WorkjetSupervisorTurn.Type;

/** Owner-selected intent; missing legacy kinds retain work review. */
export const WorkjetSupervisorTurnKind = Schema.Literals(["work", "conversation"]);
export type WorkjetSupervisorTurnKind = typeof WorkjetSupervisorTurnKind.Type;

export const WorkjetSupervisorTurnCapabilitiesResponse = Schema.Struct({
  action: Schema.Literal("project.supervisor.turn.capabilities"),
  commandId: CommandId,
  projectId: ProjectId,
  contract: Schema.Literal("ctox.workjet.supervisor_turn_capabilities.v1"),
  binding: WorkjetSupervisorBinding,
  turnKinds: Schema.Tuple([Schema.Literal("work"), Schema.Literal("conversation")]),
  defaultTurnKind: Schema.Literal("work"),
  inputContract: Schema.optionalKey(Schema.Literal("ctox.workjet.supervisor_input.v1")),
  inputDelivery: Schema.optionalKey(Schema.Literal("next_slice")),
  maxInputChars: Schema.optionalKey(Schema.Literal(4096)),
}).check(
  Schema.makeFilter((response) =>
    (response.inputContract === undefined &&
      response.inputDelivery === undefined &&
      response.maxInputChars === undefined) ||
    (response.inputContract !== undefined &&
      response.inputDelivery !== undefined &&
      response.maxInputChars !== undefined)
      ? true : "Supervisor input support needs the complete native capability.",
  ),
  Schema.makeFilter(
    (response) =>
      response.projectId === response.binding.projectId ||
      "Supervisor capability belongs to another project.",
  ),
);
export type WorkjetSupervisorTurnCapabilitiesResponse =
  typeof WorkjetSupervisorTurnCapabilitiesResponse.Type;

/** A durable submission intent, saved before dispatch. It grants no native authority. */
export const WorkjetSupervisorTurnIntent = Schema.Struct({
  instanceId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  projectId: ProjectId,
  threadId: WorkjetSupervisorThreadId,
  commandId: CommandId.check(Schema.isMaxLength(120)),
  goal: WorkjetSupervisorGoal,
  turnKind: Schema.optionalKey(WorkjetSupervisorTurnKind),
  createdAt: IsoDateTime,
});
export type WorkjetSupervisorTurnIntent = typeof WorkjetSupervisorTurnIntent.Type;

/** The command ID is also the native idempotent operation identity. */
export const WorkjetSupervisorInputIntent = Schema.Struct({
  instanceId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  projectId: ProjectId,
  threadId: WorkjetSupervisorThreadId,
  targetCommandId: Identity,
  commandId: CommandId.check(Schema.isMaxLength(120)),
  body: WorkjetSupervisorGoal,
  createdAt: IsoDateTime,
});
export type WorkjetSupervisorInputIntent = typeof WorkjetSupervisorInputIntent.Type;

export const WorkjetSupervisorInputReceipt = Schema.Struct({
  action: Schema.Literal("project.supervisor.turn.input"),
  commandId: CommandId,
  projectId: ProjectId,
  contract: Schema.Literal("ctox.workjet.supervisor_input.v1"),
  binding: WorkjetSupervisorBinding,
  turn: WorkjetSupervisorTurn,
  input: Schema.Struct({
    inputId: Identity,
    sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    body: WorkjetSupervisorGoal,
    createdAt: IsoDateTime,
  }),
  delivery: Schema.Literal("next_slice"),
  workerInterrupted: Schema.Literal(false),
}).check(Schema.makeFilter((response) =>
  response.projectId === response.binding.projectId &&
  response.binding.threadId === response.turn.threadId && response.turn.taskId !== null
    ? true : "Supervisor input belongs to another native binding or has no task.",
));
export type WorkjetSupervisorInputReceipt = typeof WorkjetSupervisorInputReceipt.Type;

export const WorkjetSupervisorInputJournal = Schema.Struct({
  intent: WorkjetSupervisorInputIntent,
  receipt: Schema.NullOr(WorkjetSupervisorInputReceipt),
  submission: Schema.Literals(["prepared", "awaiting-receipt", "confirmed"]),
}).check(Schema.makeFilter((entry) =>
  (entry.submission === "confirmed") === (entry.receipt !== null) &&
  (!entry.receipt || (entry.receipt.commandId === entry.intent.commandId &&
    entry.receipt.projectId === entry.intent.projectId &&
    entry.receipt.binding.threadId === entry.intent.threadId &&
    entry.receipt.turn.commandId === entry.intent.targetCommandId &&
    entry.receipt.input.body === entry.intent.body))
    ? true : "Supervisor input receipt does not match its saved intent.",
));
export type WorkjetSupervisorInputJournal = typeof WorkjetSupervisorInputJournal.Type;

export const WorkjetSupervisorJournal = Schema.Struct({
  intent: WorkjetSupervisorTurnIntent,
  turn: Schema.NullOr(WorkjetSupervisorTurn),
  inputs: Schema.optionalKey(Schema.Array(WorkjetSupervisorInputJournal).check(Schema.isMaxLength(128))),
  submission: Schema.Literals(["prepared", "awaiting-receipt", "confirmed", "not-submitted"]),
  submissionError: Schema.optionalKey(
    Schema.Literals([
      "invalid_input",
      "not_active",
      "launch_failed",
      "authentication_required",
      "unsupported",
      "timeout",
      "guest_failed",
      "response_too_large",
    ]),
  ),
}).check(
  Schema.makeFilter((journal) =>
    (journal.turn === null || journal.turn.threadId === journal.intent.threadId) &&
    new Set((journal.inputs ?? []).map((entry) => entry.intent.commandId)).size ===
      (journal.inputs ?? []).length &&
    (journal.inputs ?? []).every((entry) =>
      entry.intent.instanceId === journal.intent.instanceId &&
      entry.intent.projectId === journal.intent.projectId &&
      entry.intent.threadId === journal.intent.threadId &&
      entry.intent.targetCommandId === journal.turn?.commandId &&
      (!entry.receipt || entry.receipt.turn.taskId === journal.turn?.taskId)) &&
    (journal.submission === "confirmed") === (journal.turn !== null) &&
    (journal.submission !== "not-submitted" || journal.submissionError !== undefined)
      ? true
      : "The observed native turn belongs to another submission intent.",
  ),
);
export type WorkjetSupervisorJournal = typeof WorkjetSupervisorJournal.Type;
