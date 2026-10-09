import * as Schema from "effect/Schema";
import { CommandId } from "./baseSchemas.ts";

const stream = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const cursor = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const base = { action: Schema.Literal("speech.dictation"), commandId: CommandId };
const scoped = { ...base, streamId: stream };
/** Draft dictation never requires or changes a Jour fixe meeting. */
export const WorkjetDictationRequests = [
  Schema.Struct({ ...base, op: Schema.Literal("open") }),
  Schema.Struct({ ...scoped, op: Schema.Literal("write"), sequence: cursor,
    pcmBase64: Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(4268), Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/)) }),
  Schema.Struct({ ...scoped, op: Schema.Literal("read"), afterSequence: cursor }),
  Schema.Struct({ ...scoped, op: Schema.Literal("finish") }),
  Schema.Struct({ ...scoped, op: Schema.Literal("cancel") }),
] as const;
export const WorkjetDictationRequest = Schema.Union(WorkjetDictationRequests);
export type WorkjetDictationRequest = typeof WorkjetDictationRequest.Type;
export const WorkjetDictationResponse = Schema.Struct({
  ...scoped,
  op: Schema.Literals(["open", "write", "read", "finish", "cancel"]),
  state: Schema.Literals(["open", "finishing", "finished", "canceled", "failed"]),
  events: Schema.Array(Schema.Struct({ sequence: cursor, text: Schema.String.check(Schema.isMaxLength(8192)) })).check(Schema.isMaxLength(32)),
  text: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32768))),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
});
export type WorkjetDictationResponse = typeof WorkjetDictationResponse.Type;
