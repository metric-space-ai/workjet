import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  requestSpeechSettings,
  readSpeechPlaybackRate,
  speechCheckAudio,
} from "./workjetSpeechSettings";
import type { WorkjetProjectControlPort } from "../workjetProjectControl";
import { newCommandId } from "./utils";

afterEach(() => vi.useRealTimers());
const status = {
  config: { synthesis: "mistral", transcription: "mistral", voice_id: null, rate: 1.15 },
  mistral_credential_present: true,
  mistral_voice_configured: false,
  streaming_stt_selected: true,
  stt: "unknown",
  tts: "unavailable",
} as const;
describe("native speech settings consumer", () => {
  it("uses the selected instance, correlates receipts and never treats configured paths as checked", async () => {
    const port: WorkjetProjectControlPort = vi.fn<WorkjetProjectControlPort>(
      async (instance, input) => {
        expect(instance).toBe("instance-a");
        if (input.action !== "speech.settings.read") throw new Error("unexpected action");
        return { _tag: "completed", response: { ...input, status, ttsCheck: null } };
      },
    );
    const result = await requestSpeechSettings(
      "instance-a",
      { action: "speech.settings.read" },
      new AbortController().signal,
      port,
    );
    expect(result.ttsCheck).toBeNull();
    expect(result.status.config.rate).toBe(1.15);
  });
  it("rejects cross-request playback settings and rates outside the persisted contract", async () => {
    for (const rate of [0.79, 1.51]) {
      const port: WorkjetProjectControlPort = async (_, input) => {
        if (input.action !== "speech.settings.playback") throw new Error("unexpected action");
        return { _tag: "completed", response: { ...input, rate } };
      };
      await expect(
        readSpeechPlaybackRate("instance-a", new AbortController().signal, port),
      ).rejects.toThrow("invalid speech rate");
    }
    const port: WorkjetProjectControlPort = async (_, input) => {
      if (input.action !== "speech.settings.playback") throw new Error("unexpected action");
      return { _tag: "completed", response: { ...input, commandId: newCommandId(), rate: 1.15 } };
    };
    await expect(
      readSpeechPlaybackRate("instance-a", new AbortController().signal, port),
    ).rejects.toThrow("different request");
  });
  it("bounds a silent transport and discards cancellation", async () => {
    vi.useFakeTimers();
    const port: WorkjetProjectControlPort = () => new Promise(() => {});
    const pending = requestSpeechSettings(
      "instance-a",
      { action: "speech.settings.read" },
      new AbortController().signal,
      port,
    );
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25_000);
    await rejected;
    const controller = new AbortController();
    const cancelled = requestSpeechSettings(
      "instance-a",
      { action: "speech.settings.read" },
      controller.signal,
      port,
    );
    const aborted = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await aborted;
  });
  it("rejects provider JSON, malformed base64 and non-WAV audio", () => {
    expect(() => speechCheckAudio(btoa('{"audio":"private"}'))).toThrow();
    expect(() => speechCheckAudio("%%%")).toThrow();
    expect(() => speechCheckAudio(btoa("not a wave recording"))).toThrow();
  });
});
