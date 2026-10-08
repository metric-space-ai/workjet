import * as Schema from "effect/Schema";
import { CommandId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkjetJourFixeAudioRef } from "./workjetJourFixeMeeting.ts";

export const JOUR_FIXE_NARRATION_RANGE_BYTES = 256 * 1024;
export const JOUR_FIXE_NARRATION_MAX_BYTES = 8 * 1024 * 1024;
const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Uint = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const scope = { commandId: CommandId, projectId: ProjectId, meetingId: Id, slideId: Id,
  deckRevision: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })) };
export const WorkjetJourFixeNarrationReadRequest = Schema.Struct({
  action: Schema.Literal("project.jour_fixe.narration.read"), ...scope,
  offset: Uint,
  length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: JOUR_FIXE_NARRATION_RANGE_BYTES })),
});
export type WorkjetJourFixeNarrationReadRequest = typeof WorkjetJourFixeNarrationReadRequest.Type;
export const WorkjetJourFixeNarrationReadResponse = Schema.Struct({
  action: Schema.Literal("project.jour_fixe.narration.read"), ...scope, meetingRevision: Uint,
  audio: Schema.Struct({
    ...WorkjetJourFixeAudioRef.fields,
    generation_id: Id, sha256: Hash, narration_text_sha256: Hash,
    mime_type: Schema.Literal("audio/wav"), format: Schema.Literal("wav"),
    provenance: Schema.Literals(["native_gateway", "authenticated_owner_local_audio"]),
    duration_ms: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300_000 })),
  }),
  totalBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: JOUR_FIXE_NARRATION_MAX_BYTES })),
  offset: Uint,
  length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: JOUR_FIXE_NARRATION_RANGE_BYTES })),
  bytesBase64: Schema.String.check(Schema.isMaxLength(4 * Math.ceil(JOUR_FIXE_NARRATION_RANGE_BYTES / 3)),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)),
  rangeSha256: Hash,
});
export type WorkjetJourFixeNarrationReadResponse = typeof WorkjetJourFixeNarrationReadResponse.Type;
const decodeRequest = Schema.decodeUnknownSync(WorkjetJourFixeNarrationReadRequest, { onExcessProperty: "error" });
const decodeResponse = Schema.decodeUnknownSync(WorkjetJourFixeNarrationReadResponse, { onExcessProperty: "error" });
export function isWorkjetJourFixeNarrationReceiptForRequest(request: unknown, response: unknown):
  response is WorkjetJourFixeNarrationReadResponse {
  try {
    const sent = decodeRequest(request); const got = decodeResponse(response);
    return got.commandId === sent.commandId && got.projectId === sent.projectId && got.meetingId === sent.meetingId
      && got.slideId === sent.slideId && got.deckRevision === sent.deckRevision && got.offset === sent.offset
      && got.offset < got.totalBytes && got.length === Math.min(sent.length, got.totalBytes - got.offset);
  } catch { return false; }
}
