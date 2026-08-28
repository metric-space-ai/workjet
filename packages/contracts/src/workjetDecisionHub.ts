import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import {
  WorkjetConnectionId,
  WorkjetConnectionSource,
  WorkjetConnectionSummary,
} from "./workjet.ts";

const BoundedText = (maxLength: number) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(maxLength));

export const WorkjetDecisionHubProvisionInput = Schema.Struct({
  connectionId: WorkjetConnectionId,
  instanceId: BoundedText(200),
  displayName: BoundedText(200),
  source: WorkjetConnectionSource,
  endpoint: BoundedText(2_048),
  token: BoundedText(16_384),
});
export type WorkjetDecisionHubProvisionInput = typeof WorkjetDecisionHubProvisionInput.Type;

export const WorkjetDecisionHubListResult = Schema.Struct({
  connections: Schema.Array(WorkjetConnectionSummary),
});
export type WorkjetDecisionHubListResult = typeof WorkjetDecisionHubListResult.Type;

export const WorkjetDecisionHubProbeInput = Schema.Struct({
  connectionId: WorkjetConnectionId,
});
export type WorkjetDecisionHubProbeInput = typeof WorkjetDecisionHubProbeInput.Type;

export const WorkjetDecisionHubDisconnectInput = WorkjetDecisionHubProbeInput;

export const WorkjetDecisionHubConnectionResult = Schema.Struct({
  connection: WorkjetConnectionSummary,
});
export type WorkjetDecisionHubConnectionResult = typeof WorkjetDecisionHubConnectionResult.Type;

export const WorkjetDecisionHubDisconnectResult = Schema.Struct({
  connectionId: WorkjetConnectionId,
  disconnected: Schema.Boolean,
});

export const WorkjetDecisionHubConnectionErrorReason = Schema.Literals([
  "unknown-connection",
  "invalid-endpoint",
  "foreign-environment",
  "secret-store-unavailable",
  "connection-unavailable",
  "remote-identity-mismatch",
  "remote-tools-missing",
  "remote-response-invalid",
]);
export type WorkjetDecisionHubConnectionErrorReason =
  typeof WorkjetDecisionHubConnectionErrorReason.Type;

export class WorkjetDecisionHubConnectionError extends Schema.TaggedErrorClass<WorkjetDecisionHubConnectionError>()(
  "WorkjetDecisionHubConnectionError",
  { reason: WorkjetDecisionHubConnectionErrorReason },
) {}

export const WorkjetDecisionUrgency = Schema.Literals(["normal", "high", "critical"]);
export const WorkjetDecisionOption = Schema.Struct({
  id: BoundedText(100),
  label: BoundedText(120),
  description: TrimmedString.check(Schema.isMaxLength(1_000)),
});

export const WorkjetDecisionHubEscalationInput = Schema.Struct({
  decisionKey: BoundedText(200),
  title: BoundedText(160),
  question: BoundedText(2_000),
  context: TrimmedString.check(Schema.isMaxLength(8_000)),
  options: Schema.Array(WorkjetDecisionOption).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(8),
    Schema.makeFilter(
      (options) =>
        new Set(options.map((option) => option.id)).size === options.length ||
        "option ids must be unique",
    ),
  ),
  recommendationOptionId: Schema.optionalKey(BoundedText(100)),
  urgency: WorkjetDecisionUrgency,
  expiresAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
});
export type WorkjetDecisionHubEscalationInput = typeof WorkjetDecisionHubEscalationInput.Type;

export const WorkjetDecisionHubEscalationResult = Schema.Struct({
  decisionId: BoundedText(200),
  status: Schema.Literals(["open", "resolved", "expired"]),
});
export type WorkjetDecisionHubEscalationResult = typeof WorkjetDecisionHubEscalationResult.Type;

export const WorkjetDecisionHubPendingRecord = Schema.Struct({
  decisionId: BoundedText(200),
  connectionId: WorkjetConnectionId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  decisionKey: BoundedText(200),
  status: Schema.Literals(["open", "resolved", "expired"]),
  selectedOptionId: Schema.NullOr(BoundedText(100)),
  comment: Schema.NullOr(TrimmedString.check(Schema.isMaxLength(2_000))),
  resolutionVersion: NonNegativeInt,
  nextPollAtMillis: NonNegativeInt,
  attempt: NonNegativeInt,
});
