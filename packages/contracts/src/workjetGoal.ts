import * as Schema from "effect/Schema";
import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

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

/** Facts emitted by a registered provider, not the requested model selection. */
export const WorkjetGoalExecution = Schema.Struct({
  turnId: TurnId,
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  runtimeSource: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  state: Schema.Literals(["running", "completed", "failed", "interrupted", "cancelled"]),
  sourceEventId: EventId,
  observedAt: IsoDateTime,
  author: Schema.NullOr(
    Schema.Struct({
      model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
      evidence: Schema.Literal("assistant-response"),
      sourceEventId: EventId,
    }),
  ),
});
export type WorkjetGoalExecution = typeof WorkjetGoalExecution.Type;

export const WorkjetGoalExecutor = Schema.Struct({
  implementation: Schema.Literal("workjet-persistent-goal-reactor.v1"),
  goalControl: Schema.Literals(["provider-native", "workjet-emulated"]),
  providerInstanceId: ProviderInstanceId,
  observedAt: IsoDateTime,
});
export type WorkjetGoalExecutor = typeof WorkjetGoalExecutor.Type;

/** A verifier receipt is required; neither a completed turn nor a card is one. */
export const WorkjetGoalVerifiedProgress = Schema.Struct({
  verifierId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  receiptId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  turnId: TurnId,
  sourceRevision: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  verifiedAt: IsoDateTime,
});
export type WorkjetGoalVerifiedProgress = typeof WorkjetGoalVerifiedProgress.Type;

/** Persisted in the thread config and orchestration journal, never inferred from prose. */
export const WorkjetThreadGoal = Schema.Struct({
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  status: WorkjetGoalStatus,
  revision: NonNegativeInt,
  continuationCount: NonNegativeInt,
  kanban: Schema.optional(WorkjetWorkerKanban),
  lastExecution: Schema.optional(WorkjetGoalExecution),
  executor: Schema.optional(WorkjetGoalExecutor),
  lastVerifiedProgress: Schema.optional(Schema.NullOr(WorkjetGoalVerifiedProgress)),
  lastCompletedTurnId: Schema.NullOr(TurnId),
  pendingContinuation: Schema.NullOr(WorkjetGoalContinuation),
  reason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(8000))),
  updatedAt: IsoDateTime,
});
export type WorkjetThreadGoal = typeof WorkjetThreadGoal.Type;
