import * as Schema from "effect/Schema";
import { CommandId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Wire names and limits match ctox.workjet.presentation.v1
// (ctox src/core/rxdb/tests/fixtures/workjet-presentation-v1.json).
// A Jour fixe presentation is a learnordie SlideDocument stored by CTOX as
// immutable revisions; Workjet reads it in hash-checked byte ranges and saves
// one slide's canvas at a time against the revision it was edited from.
export const WORKJET_PRESENTATION_CONTRACT = "ctox.workjet.presentation.v1";
export const WORKJET_PRESENTATION_RANGE_BYTES = 128 * 1024;
export const WORKJET_PRESENTATION_MAX_BYTES = 8 * 1024 * 1024;
export const WORKJET_PRESENTATION_SCENE_MAX_CHARS = 4 * 1024 * 1024;

const text = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Unsigned = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 }),
);
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const DocumentBytes = Schema.Int.check(
  Schema.isBetween({ minimum: 2, maximum: WORKJET_PRESENTATION_MAX_BYTES }),
);
const SlideIds = Schema.Array(text(1, 128)).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
);

export const WorkjetPresentationManifest = Schema.Struct({
  presentation_id: Id,
  project_id: Id,
  meeting_id: Id,
  owner_user_id: text(1, 256),
  title: text(1, 180),
  revision: Revision,
  document_schema: text(1, 64),
  document_file_id: Id,
  document_generation_id: Id,
  document_sha256: Hash,
  document_bytes: DocumentBytes,
  slide_ids: SlideIds,
  source: Schema.Literals(["agent", "owner"]),
  updated_by: text(1, 256),
  updated_at_ms: Unsigned,
});
export type WorkjetPresentationManifest = typeof WorkjetPresentationManifest.Type;

export const WorkjetPresentationMutation = Schema.Struct({
  operation_id: Id,
  presentation_id: Id,
  project_id: Id,
  meeting_id: Id,
  revision: Revision,
  document_sha256: Hash,
  document_bytes: DocumentBytes,
  slide_ids: SlideIds,
});
export type WorkjetPresentationMutation = typeof WorkjetPresentationMutation.Type;

const scope = { commandId: CommandId, projectId: ProjectId, meetingId: Id };

export const WorkjetPresentationReadRequest = Schema.Struct({
  action: Schema.Literal("project.presentation.read"),
  ...scope,
});
export const WorkjetPresentationReadResponse = Schema.Struct({
  action: Schema.Literal("project.presentation.read"),
  ...scope,
  contract: Schema.Literal(WORKJET_PRESENTATION_CONTRACT),
  presentation: Schema.NullOr(WorkjetPresentationManifest),
});

export const WorkjetPresentationContentReadRequest = Schema.Struct({
  action: Schema.Literal("project.presentation.content.read"),
  ...scope,
  presentationId: Id,
  revision: Revision,
  offset: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: WORKJET_PRESENTATION_MAX_BYTES }),
  ),
  length: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: WORKJET_PRESENTATION_RANGE_BYTES }),
  ),
});
export const WorkjetPresentationContentReadResponse = Schema.Struct({
  action: Schema.Literal("project.presentation.content.read"),
  ...scope,
  range: Schema.Struct({
    presentation_id: Id,
    revision: Revision,
    offset: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: WORKJET_PRESENTATION_MAX_BYTES }),
    ),
    length: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: WORKJET_PRESENTATION_RANGE_BYTES }),
    ),
    total_bytes: DocumentBytes,
    document_sha256: Hash,
    data_base64: Schema.String.check(
      Schema.isMaxLength(4 * Math.ceil(WORKJET_PRESENTATION_RANGE_BYTES / 3)),
      Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    ),
  }),
  rangeSha256: Hash,
});

export const WorkjetPresentationCanvasSaveRequest = Schema.Struct({
  action: Schema.Literal("project.presentation.canvas.save"),
  ...scope,
  operationId: Id,
  presentationId: Id,
  expectedRevision: Revision,
  slideId: text(1, 120),
  sceneJson: text(2, WORKJET_PRESENTATION_SCENE_MAX_CHARS),
});
export const WorkjetPresentationCanvasSaveResponse = Schema.Struct({
  action: Schema.Literal("project.presentation.canvas.save"),
  ...scope,
  contract: Schema.Literal(WORKJET_PRESENTATION_CONTRACT),
  mutation: WorkjetPresentationMutation,
  presentation: WorkjetPresentationManifest,
});

export const WorkjetPresentationRequests = [
  WorkjetPresentationReadRequest,
  WorkjetPresentationContentReadRequest,
  WorkjetPresentationCanvasSaveRequest,
] as const;
export const WorkjetPresentationResponses = [
  WorkjetPresentationReadResponse,
  WorkjetPresentationContentReadResponse,
  WorkjetPresentationCanvasSaveResponse,
] as const;
export type WorkjetPresentationRequest =
  | typeof WorkjetPresentationReadRequest.Type
  | typeof WorkjetPresentationContentReadRequest.Type
  | typeof WorkjetPresentationCanvasSaveRequest.Type;
export type WorkjetPresentationResponse =
  | typeof WorkjetPresentationReadResponse.Type
  | typeof WorkjetPresentationContentReadResponse.Type
  | typeof WorkjetPresentationCanvasSaveResponse.Type;

const decodeRequest = Schema.decodeUnknownSync(Schema.Union(WorkjetPresentationRequests), {
  onExcessProperty: "error",
});
const decodeResponse = Schema.decodeUnknownSync(Schema.Union(WorkjetPresentationResponses), {
  onExcessProperty: "error",
});

/** True for every non-presentation action; for presentation actions the
 * response must answer exactly this request (scope, revision, range, operation). */
export function isWorkjetPresentationReceiptForRequest(request: unknown, response: unknown): boolean {
  if (
    typeof request !== "object" ||
    request === null ||
    !("action" in request) ||
    typeof request.action !== "string"
  )
    return false;
  if (!request.action.startsWith("project.presentation.")) return true;
  try {
    const sent = decodeRequest(request);
    const got = decodeResponse(response);
    if (
      got.action !== sent.action ||
      got.commandId !== sent.commandId ||
      got.projectId !== sent.projectId ||
      got.meetingId !== sent.meetingId
    )
      return false;
    if (sent.action === "project.presentation.read" && got.action === sent.action) {
      return (
        got.presentation === null ||
        (got.presentation.project_id === sent.projectId &&
          got.presentation.meeting_id === sent.meetingId)
      );
    }
    if (sent.action === "project.presentation.content.read" && got.action === sent.action) {
      const range = got.range;
      return (
        range.presentation_id === sent.presentationId &&
        range.revision === sent.revision &&
        range.offset === sent.offset &&
        range.offset < range.total_bytes &&
        range.length === Math.min(sent.length, range.total_bytes - range.offset)
      );
    }
    if (sent.action === "project.presentation.canvas.save" && got.action === sent.action) {
      return (
        got.mutation.operation_id === sent.operationId &&
        got.mutation.presentation_id === sent.presentationId &&
        got.mutation.project_id === sent.projectId &&
        got.mutation.meeting_id === sent.meetingId &&
        got.mutation.revision === sent.expectedRevision + 1 &&
        got.presentation.presentation_id === sent.presentationId &&
        got.presentation.revision === got.mutation.revision &&
        got.presentation.document_sha256 === got.mutation.document_sha256
      );
    }
    return false;
  } catch {
    return false;
  }
}
