import { prepareJourFixeNarration } from "./jourFixeNarration";
import { readSpeechPlaybackRate } from "./workjetSpeechSettings";
import type { JourFixeSpeechProvider } from "./jourFixeSpeech";

/** Read retained native narration without enabling an unconfigured microphone transport. */
export const nativeJourFixeNarrationProvider: JourFixeSpeechProvider = {
  kind: "ctox-gateway",
  microphoneAvailable: false,
  async prepareNarration(options) {
    const [blob, rate] = await Promise.all([
      prepareJourFixeNarration(options),
      readSpeechPlaybackRate(options.scope.instanceId, options.signal),
    ]);
    options.signal.throwIfAborted();
    return { blob, rate };
  },
  async startListening() {
    throw new Error("Microphone transport is not configured for this meeting.");
  },
};
