import {
  WorkjetSpeechPlaybackResponse,
  WorkjetSpeechSettingsResponse,
  type WorkjetSpeechConfig,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { newCommandId } from "./utils";
import type { CtoxWorkjetProjectControlResult } from "@workjet/contracts";
import {
  describeWorkjetProjectControlFailure,
  requestWorkjetProjectControlFromExplicitHost,
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
    const pending = requestWorkjetProjectControlFromExplicitHost(
      instanceId,
      { ...input, commandId },
      port,
    );
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
    if (result._tag !== "completed") throw speechFailure(result, instanceId);
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

type Failure = Extract<CtoxWorkjetProjectControlResult, { readonly _tag: "failed" }>;
type Language = "de" | "en";

/** A load failure with a specific, actionable German and English message. */
export class SpeechSettingsError extends Error {
  constructor(readonly messages: Readonly<Record<Language, string>>) {
    super(messages.en);
  }
}

const speechMessages = {
  core_outdated: {
    de: "CTOX auf der Instanz ist zu alt für Spracheinstellungen. CTOX aktualisieren, dann erneut laden.",
    en: "The instance runs a CTOX core without speech settings. Update CTOX, then reload.",
  },
  access_denied: {
    de: "Spracheinstellungen brauchen die Rolle Owner oder Admin auf der Instanz.",
    en: "Speech settings need the Owner or Admin role on the instance.",
  },
  peer_unavailable: {
    de: "Datenverbindung zur Instanz noch nicht bereit. Gleich erneut laden.",
    en: "The data connection to the instance is not ready yet. Reload in a moment.",
  },
  request_timeout: {
    de: "Instanz hat nicht rechtzeitig geantwortet. Erneut laden.",
    en: "The instance did not answer in time. Reload.",
  },
  unanswered: {
    de: "Instanz beantwortet Spracheinstellungen nicht. CTOX aktualisieren und Rolle Owner/Admin prüfen.",
    en: "The instance does not answer speech settings. Update CTOX and check the Owner/Admin role.",
  },
} as const;

function speechFailure(failure: Failure, instanceId: string): SpeechSettingsError {
  const reason = failure.diagnostic?.reason;
  if (reason && reason in speechMessages)
    return new SpeechSettingsError(speechMessages[reason as keyof typeof speechMessages]);
  if (failure.code === "timeout") return new SpeechSettingsError(speechMessages.request_timeout);
  // Older CTOX shells only report an opaque guest failure for speech settings.
  if (failure.code === "guest_failed" && !failure.diagnostic)
    return new SpeechSettingsError(speechMessages.unanswered);
  const de = describeWorkjetProjectControlFailure(failure, instanceId);
  return new SpeechSettingsError({ de, en: de });
}

export function speechErrorText(error: unknown, language: Language): string {
  if (error instanceof SpeechSettingsError) return error.messages[language];
  return language === "en"
    ? "Speech settings not loaded or saved."
    : "Nicht geladen oder gespeichert";
}
