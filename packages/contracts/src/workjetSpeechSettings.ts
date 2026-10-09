import * as Schema from "effect/Schema";
import { CommandId } from "./baseSchemas.ts";

export const WorkjetSpeechRate = Schema.Number.check(Schema.isBetween({ minimum: 0.8, maximum: 1.5 }));
const Backend = Schema.Literals(["runtime", "mistral", "computer"]);
export const WorkjetSpeechConfig = Schema.Struct({
  synthesis: Backend,
  transcription: Backend,
  voice_id: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  rate: WorkjetSpeechRate,
});
export type WorkjetSpeechConfig = typeof WorkjetSpeechConfig.Type;
const base = { commandId: CommandId };
export const WorkjetSpeechSettingsRequests = [
  Schema.Struct({ action: Schema.Literal("speech.settings.read"), ...base }),
  Schema.Struct({ action: Schema.Literal("speech.settings.configure"), ...base, config: WorkjetSpeechConfig }),
  Schema.Struct({ action: Schema.Literal("speech.settings.key"), ...base, secret: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)) }),
  Schema.Struct({ action: Schema.Literal("speech.settings.voices"), ...base }),
  Schema.Struct({ action: Schema.Literal("speech.settings.check"), ...base }),
  Schema.Struct({ action: Schema.Literal("speech.settings.playback"), ...base }),
] as const;
const Check = Schema.Struct({
  state: Schema.Literals(["ok", "error"]),
  checkedAt: Schema.String.check(Schema.isMaxLength(64)),
  latencyMs: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  errorClass: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
});
export const WorkjetSpeechSettingsResponse = Schema.Struct({
  action: Schema.Literals(["speech.settings.read", "speech.settings.configure", "speech.settings.key", "speech.settings.voices", "speech.settings.check"]),
  ...base,
  status: Schema.Struct({
    config: WorkjetSpeechConfig,
    mistral_credential_present: Schema.Boolean,
    mistral_voice_configured: Schema.Boolean,
    streaming_stt_selected: Schema.Boolean,
    stt: Schema.Literals(["available", "unavailable", "unknown"]),
    tts: Schema.Literals(["available", "unavailable", "unknown"]),
  }),
  ttsCheck: Schema.NullOr(Check),
  voices: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)), name: Schema.String.check(Schema.isMaxLength(256)) })).check(Schema.isMaxLength(100))),
  audioBase64: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(12 * 1024 * 1024), Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/))),
});
export type WorkjetSpeechSettingsResponse = typeof WorkjetSpeechSettingsResponse.Type;
export const WorkjetSpeechPlaybackResponse = Schema.Struct({
  action: Schema.Literal("speech.settings.playback"), ...base, rate: WorkjetSpeechRate,
});
