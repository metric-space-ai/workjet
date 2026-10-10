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
export const WorkjetWorkerKanban = Schema.Struct({
  goalRevision: NonNegativeInt,
  iteration: NonNegativeInt,
  cards: Schema.Array(WorkjetWorkerKanbanCard).check(Schema.isMaxLength(30)),
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
