import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const WORKJET_SESSION_IMPORT_MAX_CANDIDATES = 100;
export const WORKJET_SESSION_IMPORT_MAX_SELECTION = 20;

const CandidateId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^wjsi_[a-f0-9]{32}$/u),
);

export const WorkjetSessionImportSource = Schema.Literals(["codex", "claude-code"]);
export type WorkjetSessionImportSource = typeof WorkjetSessionImportSource.Type;

export const WorkjetSessionImportCandidate = Schema.Struct({
  candidateId: CandidateId,
  source: WorkjetSessionImportSource,
  providerInstanceId: ProviderInstanceId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  sourceSizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  importedThreadId: Schema.NullOr(ThreadId),
  workspaceAvailable: Schema.Boolean,
});
export type WorkjetSessionImportCandidate = typeof WorkjetSessionImportCandidate.Type;

export const WorkjetSessionImportSourceSummary = Schema.Struct({
  source: WorkjetSessionImportSource,
  configured: Schema.Boolean,
  discoveredCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  shownCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type WorkjetSessionImportSourceSummary = typeof WorkjetSessionImportSourceSummary.Type;

export const WorkjetSessionImportInspectInput = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(WORKJET_SESSION_IMPORT_MAX_CANDIDATES),
    ),
  ),
});
export type WorkjetSessionImportInspectInput = typeof WorkjetSessionImportInspectInput.Type;

export const WorkjetSessionImportInspection = Schema.Struct({
  sources: Schema.Array(WorkjetSessionImportSourceSummary).check(Schema.isMaxLength(2)),
  candidates: Schema.Array(WorkjetSessionImportCandidate).check(
    Schema.isMaxLength(WORKJET_SESSION_IMPORT_MAX_CANDIDATES),
  ),
  truncated: Schema.Boolean,
});
export type WorkjetSessionImportInspection = typeof WorkjetSessionImportInspection.Type;

export const WorkjetSessionImportInput = Schema.Struct({
  candidateIds: Schema.Array(CandidateId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(WORKJET_SESSION_IMPORT_MAX_SELECTION),
  ),
});
export type WorkjetSessionImportInput = typeof WorkjetSessionImportInput.Type;

export const WorkjetSessionImportItemResult = Schema.Struct({
  candidateId: CandidateId,
  status: Schema.Literals(["imported", "updated", "unchanged", "failed"]),
  threadId: Schema.NullOr(ThreadId),
  importedMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
});
export type WorkjetSessionImportItemResult = typeof WorkjetSessionImportItemResult.Type;

export const WorkjetSessionImportResult = Schema.Struct({
  items: Schema.Array(WorkjetSessionImportItemResult).check(
    Schema.isMaxLength(WORKJET_SESSION_IMPORT_MAX_SELECTION),
  ),
});
export type WorkjetSessionImportResult = typeof WorkjetSessionImportResult.Type;

export const WorkjetSessionImportErrorReason = Schema.Literals([
  "source_unavailable",
  "candidate_expired",
  "source_unreadable",
  "source_changed",
  "session_too_large",
  "import_failed",
]);
export type WorkjetSessionImportErrorReason = typeof WorkjetSessionImportErrorReason.Type;

export class WorkjetSessionImportError extends Schema.TaggedErrorClass<WorkjetSessionImportError>()(
  "WorkjetSessionImportError",
  {
    reason: WorkjetSessionImportErrorReason,
    subject: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "source_unavailable":
        return "The selected session source is unavailable on this environment.";
      case "candidate_expired":
        return "The selected session is no longer available. Refresh the session list.";
      case "source_unreadable":
        return "The selected session transcript could not be read.";
      case "source_changed":
        return "The source prefix or its Workjet copy changed. They were kept separate and no messages were appended.";
      case "session_too_large":
        return "The selected session exceeds the safe static-import limits.";
      case "import_failed":
        return "The static session copy could not be imported.";
    }
  }
}
