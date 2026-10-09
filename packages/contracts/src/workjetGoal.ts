import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, MessageId, NonNegativeInt, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";

export const WorkjetGoalStatus = Schema.Literals(["active", "paused", "blocked", "complete"]);
export type WorkjetGoalStatus = typeof WorkjetGoalStatus.Type;

export const WorkjetGoalContinuation = Schema.Struct({
  commandId: CommandId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});
export type WorkjetGoalContinuation = typeof WorkjetGoalContinuation.Type;

/** Persisted in the thread config and orchestration journal, never inferred from prose. */
export const WorkjetThreadGoal = Schema.Struct({
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  status: WorkjetGoalStatus,
  revision: NonNegativeInt,
  continuationCount: NonNegativeInt,
  lastCompletedTurnId: Schema.NullOr(TurnId),
  pendingContinuation: Schema.NullOr(WorkjetGoalContinuation),
  reason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(8000))),
  updatedAt: IsoDateTime,
});
export type WorkjetThreadGoal = typeof WorkjetThreadGoal.Type;
