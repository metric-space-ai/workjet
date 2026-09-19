import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Goal = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const Identity = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

/** Actual execution identity, captured from the provider session rather than a title. */
export const WorkjetTeamExecutionIdentity = Schema.Struct({
  providerInstanceId: Identity,
  model: Identity,
  harness: Identity,
  harnessVersion: Schema.NullOr(Identity),
});
export type WorkjetTeamExecutionIdentity = typeof WorkjetTeamExecutionIdentity.Type;

const memberFields = {
  projectId: ProjectId,
  threadId: ThreadId,
  goal: Goal,
  createdAt: IsoDateTime,
};

/** Team ownership supplements the existing thread/provider configuration. */
export const WorkjetProjectTeamMember = Schema.Union([
  Schema.Struct({
    ...memberFields,
    role: Schema.Literal("supervisor"),
    parentThreadId: Schema.Null,
  }),
  Schema.Struct({
    ...memberFields,
    role: Schema.Literal("specialist"),
    parentThreadId: ThreadId,
    domain: Identity,
  }),
  Schema.Struct({
    ...memberFields,
    role: Schema.Literal("worker"),
    parentThreadId: ThreadId,
    packageId: Identity,
  }),
]);
export type WorkjetProjectTeamMember = typeof WorkjetProjectTeamMember.Type;

export const WorkjetTeamReviewScore = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(10),
);

/** Availability failures are separate events, never capability scores. */
export const WorkjetTeamReview = Schema.Struct({
  reviewId: Identity,
  packageId: Identity,
  reviewerThreadId: ThreadId,
  subjectThreadId: ThreadId,
  execution: WorkjetTeamExecutionIdentity,
  taskType: Schema.Literals(["backend", "ui", "security", "tests", "refactor", "devops", "docs", "other"]),
  difficulty: Schema.Literals(["small", "standard", "hard"]),
  phase: Schema.Literals(["first-delivery", "final-delivery", "handover", "review", "lifecycle"]),
  score: WorkjetTeamReviewScore,
  practice: Goal,
  evidenceRef: TrimmedNonEmptyString,
  recordedAt: IsoDateTime,
});
export type WorkjetTeamReview = typeof WorkjetTeamReview.Type;
