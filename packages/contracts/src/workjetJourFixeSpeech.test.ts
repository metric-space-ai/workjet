import { describe, expect, it } from "vite-plus/test";
import { isWorkjetJourFixeSpeechReceiptForRequest as matches } from "./workjetJourFixeSpeech.ts";
import { isWorkjetJourFixeReceiptForRequest } from "./workjetJourFixeOwner.ts";
const id = "11111111-1111-4111-8111-111111111111";
const common = {
  action: "project.jour_fixe.speech",
  projectId: "project",
  meetingId: "meeting",
  deckRevision: 1,
};
const intent = { ...common, op: "finish", streamId: id };
const response = {
  ...intent,
  state: "committed",
  events: [],
  receipt: { handle: id, meetingRevision: 1 },
  error: null,
};
describe("native speech receipt contract", () => {
  it("matches only the exact operation and immutable scope", () => {
    expect(matches(intent, response)).toBe(true);
    expect(isWorkjetJourFixeReceiptForRequest(intent, response)).toBe(true);
    for (const field of ["projectId", "meetingId", "streamId", "deckRevision", "op"])
      expect(
        matches(intent, { ...response, [field]: field === "deckRevision" ? 2 : "other" }),
      ).toBe(false);
  });
  it("rejects absent private handle, fabricated final text and caller speech proofs", () => {
    expect(matches(intent, { ...response, receipt: null })).toBe(false);
    expect(matches(intent, { ...response, text: "forged" })).toBe(false);
    expect(matches({ ...intent, text: "forged" }, response)).toBe(false);
  });
  it("correlates open by request nonce, never by a caller-created stream", () => {
    const open = { ...common, op: "open", requestId: id };
    expect(
      matches(open, { ...response, op: "open", state: "open", receipt: null, requestId: id }),
    ).toBe(true);
    expect(
      matches(open, {
        ...response,
        op: "open",
        state: "open",
        receipt: null,
        requestId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe(false);
  });
});
