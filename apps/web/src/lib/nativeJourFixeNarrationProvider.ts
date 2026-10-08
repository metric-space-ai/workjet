import { prepareJourFixeNarration } from "./jourFixeNarration";
import type { JourFixeSpeechProvider } from "./jourFixeSpeech";

/** Read retained native narration without enabling an unconfigured microphone transport. */
export const nativeJourFixeNarrationProvider: JourFixeSpeechProvider = {
  kind: "ctox-gateway",
  microphoneAvailable: false,
  prepareNarration: prepareJourFixeNarration,
  async startListening() {
    throw new Error("Microphone transport is not configured for this meeting.");
  },
};
