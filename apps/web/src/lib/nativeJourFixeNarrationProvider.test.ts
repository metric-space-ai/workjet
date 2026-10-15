import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./jourFixeNarration", () => ({
  prepareJourFixeNarration: vi.fn(async () => new Blob(["RIFF"], { type: "audio/wav" })),
}));
vi.mock("./workjetSpeechSettings", () => ({
  readSpeechPlaybackRate: vi.fn(async () => {
    throw new Error("guest_failed");
  }),
}));

import { nativeJourFixeNarrationProvider } from "./nativeJourFixeNarrationProvider";

describe("nativeJourFixeNarrationProvider", () => {
  it("keeps the narration when the speed setting cannot be read", async () => {
    const prepared = await nativeJourFixeNarrationProvider.prepareNarration({
      scope: { instanceId: "managed:welsch", projectId: "p", meetingId: "m", deckRevision: 1 },
      slideId: "slide-goal",
      signal: new AbortController().signal,
    });
    expect(prepared).not.toBeInstanceOf(Blob);
    if (prepared instanceof Blob) return;
    expect(prepared.blob.type).toBe("audio/wav");
    expect(prepared.rate).toBe(1.15);
  });
});
