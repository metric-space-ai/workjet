import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
  sourceThreadId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  providerInstanceId: ProviderInstanceId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  sourceSizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  importedThreadId: Schema.NullOr(ThreadId),
  workspaceAvailable: Schema.Boolean,
  previewMessages: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        role: Schema.Literals(["user", "assistant"]),
        text: Schema.String.check(Schema.isMaxLength(1_000)),
      }),
    ).check(Schema.isMaxLength(3)),
  ),
  importedCopies: Schema.optionalKey(
    Schema.Array(Schema.Struct({ projectId: ProjectId, threadId: ThreadId })),
  ),
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
  offset: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  source: Schema.optionalKey(WorkjetSessionImportSource),
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
  discoveryVersion: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  nextOffset: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),
  discoveryLimitReached: Schema.optionalKey(Schema.Boolean),
});
export type WorkjetSessionImportInspection = typeof WorkjetSessionImportInspection.Type;

export const WorkjetSessionImportInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
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
  "project_unavailable",
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
      case "project_unavailable":
        return "The selected destination project is no longer available on this computer.";
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
