import {
  WorkjetSpeechPlaybackResponse,
  WorkjetSpeechSettingsResponse,
  type WorkjetSpeechConfig,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { newCommandId } from "./utils";
import {
  describeWorkjetProjectControlFailure,
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "../workjetProjectControl";

type Input =
  | {
      readonly action:
        | "speech.settings.read"
        | "speech.settings.voices"
        | "speech.settings.check"
        | "speech.settings.check.transcription";
    }
  | { readonly action: "speech.settings.configure"; readonly config: WorkjetSpeechConfig }
  | { readonly action: "speech.settings.key"; readonly secret: string }
  | { readonly action: "speech.settings.playback" };

async function request(
  instanceId: string,
  input: Input,
  signal: AbortSignal,
  port?: WorkjetProjectControlPort,
) {
  signal.throwIfAborted();
  const commandId = newCommandId();
  // A renderer timeout cannot cancel native IO. The server bounds the short
  // probe to 20 seconds; late receipts are discarded after cancellation.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const pending = requestWorkjetProjectControl(instanceId, { ...input, commandId }, port);
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Speech request timed out. Retry the check.")),
          input.action === "speech.settings.check.transcription" ? 30_000 : 25_000,
        );
        onAbort = () => reject(new DOMException("Cancelled", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
    signal.throwIfAborted();
    if (result._tag !== "completed")
      throw new Error(describeWorkjetProjectControlFailure(result, instanceId));
    if (
      result.response.action !== input.action ||
      !("commandId" in result.response) ||
      result.response.commandId !== commandId
    )
      throw new Error("Speech response belongs to a different request.");
    return result.response;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function requestSpeechSettings(
  instanceId: string,
  input: Exclude<Input, { readonly action: "speech.settings.playback" }>,
  signal: AbortSignal,
  port?: WorkjetProjectControlPort,
): Promise<WorkjetSpeechSettingsResponse> {
  const result = await request(instanceId, input, signal, port);
  try {
    return Schema.decodeUnknownSync(WorkjetSpeechSettingsResponse)(result);
  } catch {
    throw new Error(
      "The connected CTOX instance returned unsupported speech settings. Update CTOX.",
    );
  }
}

export async function readSpeechPlaybackRate(
  instanceId: string,
  signal: AbortSignal,
  port?: WorkjetProjectControlPort,
): Promise<number> {
  const result = await request(instanceId, { action: "speech.settings.playback" }, signal, port);
  try {
    return Schema.decodeUnknownSync(WorkjetSpeechPlaybackResponse)(result).rate;
  } catch {
    throw new Error("The connected CTOX instance returned an invalid speech rate. Update CTOX.");
  }
}

/** Native WAV bytes only. Nothing is fetched from a URL supplied by a provider. */
export function speechCheckAudio(encoded: string): Blob {
  const raw = atob(encoded);
  if (
    raw.length < 44 ||
    raw.length > 8 * 1024 * 1024 ||
    raw.slice(0, 4) !== "RIFF" ||
    raw.slice(8, 12) !== "WAVE"
  )
    throw new Error("The speech check did not return a supported WAV recording.");
  return new Blob([Uint8Array.from(raw, (c) => c.charCodeAt(0))], { type: "audio/wav" });
}
