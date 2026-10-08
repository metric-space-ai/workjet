import { EnvironmentId, type WorkjetSpeechRoute } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isSpeechComputerConfirmed,
  routeFor,
  speechCapabilityLabel,
  withSpeechComputer,
  type SpeechComputerOption,
} from "./speechRoutes";

const GPU3 = EnvironmentId.make("gpu-3");

describe("speech route helpers", () => {
  it("returns a standard route when a kind has no stored selection", () => {
    expect(routeFor([], "spontan")).toEqual({
      sessionKind: "spontan",
      sttEnvironmentId: null,
      ttsEnvironmentId: null,
    });
  });

  it("changes one direction and leaves the other untouched", () => {
    const base: WorkjetSpeechRoute = {
      sessionKind: "regeltermin",
      sttEnvironmentId: null,
      ttsEnvironmentId: GPU3,
    };
    expect(withSpeechComputer(base, "stt", GPU3)).toEqual({
      sessionKind: "regeltermin",
      sttEnvironmentId: GPU3,
      ttsEnvironmentId: GPU3,
    });
    expect(withSpeechComputer(base, "tts", null).ttsEnvironmentId).toBeNull();
  });

  it("only treats a computer as confirmed when the server reports it available", () => {
    const computer: SpeechComputerOption = {
      environmentId: GPU3,
      label: "gpu3",
      capability: { stt: "available", tts: "unknown" },
    };
    expect(isSpeechComputerConfirmed(computer, "stt")).toBe(true);
    expect(isSpeechComputerConfirmed(computer, "tts")).toBe(false);
    expect(isSpeechComputerConfirmed(undefined, "stt")).toBe(false);
  });

  it("labels an unknown capability as unknown rather than available", () => {
    expect(speechCapabilityLabel("unknown")).toBe("Verfügbarkeit unbekannt");
  });
});
