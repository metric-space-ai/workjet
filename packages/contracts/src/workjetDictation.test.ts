import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { CommandId } from "./baseSchemas.ts";
import { CtoxWorkjetProjectControlRequest, CtoxWorkjetProjectControlResponse } from "./ctox.ts";
import { WorkjetDictationRequest } from "./workjetDictation.ts";

const commandId = CommandId.make("dictation-acceptance");
describe("standalone draft dictation contract", () => {
  it("crosses project-control IPC without a project, meeting or transcript commit", () => {
    expect(
      Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest)({
        action: "speech.dictation",
        commandId,
        op: "open",
      }),
    ).toEqual({ action: "speech.dictation", commandId, op: "open" });
    expect(
      Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse)({
        action: "speech.dictation",
        commandId,
        op: "finish",
        streamId: "recording",
        state: "finished",
        events: [],
        text: "Draft text",
        error: null,
      }).action,
    ).toBe("speech.dictation");
  });
  it.each([0, -1, 1.5])("rejects an invalid audio sequence %s", (sequence) => {
    expect(() =>
      Schema.decodeUnknownSync(WorkjetDictationRequest)({
        action: "speech.dictation",
        commandId,
        op: "write",
        streamId: "recording",
        sequence,
        pcmBase64: "AAA=",
      }),
    ).toThrow();
  });
  it("bounds audio frames at the same 100ms limit as microphone capture", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkjetDictationRequest)({
        action: "speech.dictation",
        commandId,
        op: "write",
        streamId: "recording",
        sequence: 1,
        pcmBase64: "A".repeat(4272),
      }),
    ).toThrow();
  });
});
