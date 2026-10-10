import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";

export const WorkjetGoalStatus = Schema.Literals(["active", "paused", "blocked", "complete"]);
export type WorkjetGoalStatus = typeof WorkjetGoalStatus.Type;

export const WorkjetGoalContinuation = Schema.Struct({
  commandId: CommandId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});
export type WorkjetGoalContinuation = typeof WorkjetGoalContinuation.Type;

export const WorkjetWorkerKanbanCard = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  status: Schema.Literals(["todo", "doing", "done", "blocked"]),
  evidence: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2000))),
});
/** Server-generated canonical SlideDocument; older card-only snapshots remain readable. */
export const WorkjetWorkerKanbanSlideDocument = Schema.Struct({
  schemaVersion: Schema.Literal("learnordie.slide.v1"),
  documentJson: TrimmedNonEmptyString.check(Schema.isMaxLength(131072)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type WorkjetWorkerKanbanSlideDocument = typeof WorkjetWorkerKanbanSlideDocument.Type;

export const WorkjetWorkerKanban = Schema.Struct({
  goalRevision: NonNegativeInt,
  iteration: NonNegativeInt,
  cards: Schema.Array(WorkjetWorkerKanbanCard).check(Schema.isMaxLength(30)),
  slideDocument: Schema.optional(WorkjetWorkerKanbanSlideDocument),
  updatedAt: IsoDateTime,
});
export type WorkjetWorkerKanban = typeof WorkjetWorkerKanban.Type;

/** Persisted in the thread config and orchestration journal, never inferred from prose. */
export const WorkjetThreadGoal = Schema.Struct({
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  status: WorkjetGoalStatus,
  revision: NonNegativeInt,
  continuationCount: NonNegativeInt,
  kanban: Schema.optional(WorkjetWorkerKanban),
  lastCompletedTurnId: Schema.NullOr(TurnId),
  pendingContinuation: Schema.NullOr(WorkjetGoalContinuation),
  reason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(8000))),
  updatedAt: IsoDateTime,
});
export type WorkjetThreadGoal = typeof WorkjetThreadGoal.Type;
