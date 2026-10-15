import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
const positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const cursor = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const common = {
  action: Schema.Literal("project.jour_fixe.speech"),
  projectId: ProjectId,
  meetingId: text,
  deckRevision: positive,
};
export const WorkjetJourFixeSpeechRequests = [
  Schema.Struct({ ...common, op: Schema.Literal("open"), requestId: uuid }),
  Schema.Struct({
    ...common,
    op: Schema.Literal("write"),
    streamId: uuid,
    sequence: positive,
    pcmBase64: Schema.String.check(
      Schema.isMinLength(4),
      Schema.isMaxLength(4268),
      Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
    ),
  }),
  Schema.Struct({ ...common, op: Schema.Literal("read"), streamId: uuid, afterSequence: cursor }),
  Schema.Struct({ ...common, op: Schema.Literal("finish"), streamId: uuid }),
  Schema.Struct({ ...common, op: Schema.Literal("cancel"), streamId: uuid }),
] as const;
export const WorkjetJourFixeSpeechRequest = Schema.Union(WorkjetJourFixeSpeechRequests);
export type WorkjetJourFixeSpeechRequest = typeof WorkjetJourFixeSpeechRequest.Type;
export const WorkjetJourFixeSpeechResponse = Schema.Struct({
  ...common,
  op: Schema.Literals(["open", "write", "read", "finish", "cancel"]),
  streamId: uuid,
  state: Schema.Literals(["open", "finishing", "committed", "canceled", "failed"]),
  requestId: Schema.optionalKey(uuid),
  events: Schema.Array(
    Schema.Struct({
      sequence: positive,
      producerSequence: positive,
      text: Schema.String.check(Schema.isMaxLength(8192)),
    }),
  ).check(Schema.isMaxLength(32)),
  receipt: Schema.NullOr(Schema.Struct({ handle: uuid, meetingRevision: positive })),
  error: Schema.NullOr(
    Schema.Literals([
      "canceled",
      "retired",
      "timeout",
      "invalid_sequence_or_audio",
      "backpressure",
      "invalid_finish",
      "invalid_response",
      "commit_failed",
      "gateway_failed",
      "missing_final",
    ]),
  ),
}).check(
  Schema.makeFilter(
    (v) =>
      ((v.state !== "committed" || (v.receipt !== null && v.error === null)) &&
        (v.state !== "failed" || v.error !== null)) ||
      "Missing native speech terminal receipt.",
  ),
);
export type WorkjetJourFixeSpeechResponse = typeof WorkjetJourFixeSpeechResponse.Type;
const decodeRequest = Schema.decodeUnknownSync(WorkjetJourFixeSpeechRequest, {
  onExcessProperty: "error",
});
const decode = Schema.decodeUnknownSync(WorkjetJourFixeSpeechResponse, {
  onExcessProperty: "error",
});
export function isWorkjetJourFixeSpeechReceiptForRequest(
  request: unknown,
  response: unknown,
): boolean {
  if (typeof request !== "object" || request === null || !("action" in request)) return false;
  if (request.action !== "project.jour_fixe.speech") return true;
  try {
    const intent = decodeRequest(request);
    const receipt = decode(response);
    return (
      receipt.action === intent.action &&
      receipt.op === intent.op &&
      receipt.projectId === intent.projectId &&
      receipt.meetingId === intent.meetingId &&
      receipt.deckRevision === intent.deckRevision &&
      (intent.op === "open"
        ? receipt.requestId === intent.requestId
        : receipt.streamId === intent.streamId && receipt.requestId === undefined)
    );
  } catch {
    return false;
  }
}
