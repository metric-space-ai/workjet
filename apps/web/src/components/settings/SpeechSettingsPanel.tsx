import { useEffect, useRef, useState } from "react";
import { CheckIcon, CircleDashedIcon, RefreshCwIcon, XIcon } from "lucide-react";
import type { WorkjetSpeechConfig, WorkjetSpeechSettingsResponse } from "@workjet/contracts";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { requestSpeechSettings, speechCheckAudio } from "../../lib/workjetSpeechSettings";

const controlClass = "h-8 min-w-0 rounded-md border border-border bg-background px-2 text-sm";
const remedies: Readonly<Record<string, string>> = {
  missing_credential: "Enter your Mistral API key.",
  missing_voice: "Choose a saved Mistral voice.",
  credentials_rejected: "Replace the rejected Mistral API key.",
  access_denied: "Check this key's speech permissions in your Mistral account.",
  quota: "Check the available credit in your Mistral account.",
  rate_limit: "The API rate limit was reached. Retry later.",
  timeout: "The API did not respond in time. Retry the check.",
  invalid_audio: "The API returned an invalid recording. Retry the check.",
  invalid_transcript: "The API did not return a final transcript. Retry the check.",
  backend_unavailable: "This check requires the Mistral API speech path.",
};

export function SpeechSettingsPanel() {
  const { selectedId } = useCtoxMode();
  return (
    <SettingsPageContainer wide>
      {selectedId ? (
        <InstanceSpeechSettings key={selectedId} instanceId={selectedId} />
      ) : (
        <p role="status" className="px-4 text-sm text-muted-foreground">
          Select a CTOX instance to configure speech.
        </p>
      )}
    </SettingsPageContainer>
  );
}

function InstanceSpeechSettings({ instanceId }: { readonly instanceId: string }) {
  const [settings, setSettings] = useState<WorkjetSpeechSettingsResponse>();
  const [voices, setVoices] = useState<NonNullable<WorkjetSpeechSettingsResponse["voices"]>>([]);
  const [key, setKey] = useState("");
  const [rate, setRate] = useState("1.15");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [recording, setRecording] = useState<string>();
  const [transcript, setTranscript] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  const audio = useRef<HTMLAudioElement>(null);
  const url = useRef<string | undefined>(undefined);

  function releaseAudio() {
    audio.current?.pause();
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = undefined;
    setRecording(undefined);
  }

  async function run(input: Parameters<typeof requestSpeechSettings>[1]) {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setBusy(input.action);
    setError(undefined);
    if (input.action === "speech.settings.check.transcription") setTranscript(undefined);
    if (input.action !== "speech.settings.voices" && input.action !== "speech.settings.read")
      releaseAudio();
    try {
      const result = await requestSpeechSettings(instanceId, input, active.signal);
      if (active.signal.aborted) return;
      setSettings(result);
      setRate(String(result.status.config.rate));
      if (result.voices) setVoices(result.voices);
      if (result.transcript) setTranscript(result.transcript);
      if (result.audioBase64) {
        url.current = URL.createObjectURL(speechCheckAudio(result.audioBase64));
        setRecording(url.current);
      }
      return result;
    } catch {
      if (!active.signal.aborted)
        setError(
          "Speech settings could not be loaded or saved. Check the instance connection and Owner/Admin access, then retry.",
        );
    } finally {
      if (controller.current === active && !active.signal.aborted) setBusy(undefined);
    }
  }

  useEffect(() => {
    void run({ action: "speech.settings.read" }).then((result) => {
      if (result?.status.mistral_credential_present) void run({ action: "speech.settings.voices" });
    });
    return () => {
      controller.current?.abort();
      audio.current?.pause();
      if (url.current) URL.revokeObjectURL(url.current);
    };
    // This component is remounted when its instance changes.
  }, [instanceId]);

  useEffect(() => {
    if (audio.current && settings) {
      audio.current.preservesPitch = true;
      audio.current.playbackRate = settings.status.config.rate;
    }
  }, [recording, settings]);

  function configure(config: WorkjetSpeechConfig) {
    void run({ action: "speech.settings.configure", config });
  }
  const config = settings?.status.config;
  const check = settings?.ttsCheck;
  const checked = check?.state === "ok";
  const pending = busy === "speech.settings.check";
  const sttCheck = settings?.sttCheck;
  const sttPending = busy === "speech.settings.check.transcription";
  const disabled = busy !== undefined || !config;
  return (
    <SettingsSection
      title="Speech"
      id="speech"
      headerAction={
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== undefined}
          onClick={() => void run({ action: "speech.settings.read" })}
        >
          <RefreshCwIcon className="size-3.5" /> Refresh
        </Button>
      }
    >
      {error && (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="divide-y divide-border rounded-lg border border-border">
        <SettingsRow
          title="Mistral API"
          description="Speech for this CTOX instance and its meetings."
          control={
            <span
              className="flex items-center gap-2 text-xs"
              role="status"
              title={check ? "Checked " + check.checkedAt : "No successful audio check yet"}
            >
              {pending ? (
                <CircleDashedIcon className="size-4 animate-spin text-muted-foreground" />
              ) : checked ? (
                <CheckIcon className="size-4 text-emerald-500" />
              ) : check ? (
                <XIcon className="size-4 text-destructive" />
              ) : (
                <CircleDashedIcon className="size-4 text-muted-foreground" />
              )}
              {pending
                ? "Checking…"
                : checked
                  ? "Voice checked · " + check.latencyMs + " ms"
                  : check
                    ? check.errorClass
                    : "Not checked"}
            </span>
          }
        />
        <SettingsRow
          title="API key"
          description={
            settings?.status.mistral_credential_present
              ? "Key stored securely in this instance."
              : "No Mistral key saved."
          }
          control={
            <form
              className="flex w-full items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const secret = key;
                setKey("");
                void run({ action: "speech.settings.key", secret }).then((result) => {
                  if (result?.status.mistral_credential_present)
                    void run({ action: "speech.settings.voices" });
                });
              }}
            >
              <input
                aria-label="Mistral API key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                maxLength={4096}
                className={controlClass + " w-full sm:w-64"}
                placeholder={
                  settings?.status.mistral_credential_present ? "Replace API key" : "Enter API key"
                }
                disabled={disabled}
                onChange={(event) => setKey(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={disabled || key.trim().length === 0}>
                Save key
              </Button>
            </form>
          }
        />
        <SettingsRow
          title="Narration"
          control={
            <select
              aria-label="Narration path"
              className={controlClass + " w-full sm:w-64"}
              value={config?.synthesis ?? "runtime"}
              disabled={disabled}
              onChange={(event) =>
                config &&
                configure({
                  ...config,
                  synthesis: event.target.value === "mistral" ? "mistral" : "runtime",
                })
              }
            >
              <option value="runtime">Configured local runtime</option>
              <option value="mistral">Mistral API</option>
              {config?.synthesis === "computer" && (
                <option value="computer">Authorized speech computer</option>
              )}
            </select>
          }
        />
        <SettingsRow
          title="Transcription"
          control={
            <select
              aria-label="Transcription path"
              className={controlClass + " w-full sm:w-64"}
              value={config?.transcription ?? "runtime"}
              disabled={disabled}
              onChange={(event) =>
                config &&
                configure({
                  ...config,
                  transcription: event.target.value === "mistral" ? "mistral" : "runtime",
                })
              }
            >
              <option value="runtime">Configured local runtime</option>
              <option value="mistral">Mistral API</option>
              {config?.transcription === "computer" && (
                <option value="computer">Authorized speech computer</option>
              )}
            </select>
          }
        />
        <SettingsRow
          title="Voice"
          control={
            <div className="flex w-full items-center gap-2">
              <select
                aria-label="Saved Mistral voice"
                className={controlClass + " w-full sm:w-64"}
                value={config?.voice_id ?? ""}
                disabled={disabled || config?.synthesis !== "mistral"}
                onChange={(event) =>
                  config && configure({ ...config, voice_id: event.target.value || null })
                }
              >
                <option value="">Choose a saved voice</option>
                {config?.voice_id && !voices.some((voice) => voice.id === config.voice_id) && (
                  <option value={config.voice_id}>Current voice · {config.voice_id}</option>
                )}
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name || voice.id}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !settings?.status.mistral_credential_present}
                onClick={() => void run({ action: "speech.settings.voices" })}
              >
                Load voices
              </Button>
            </div>
          }
        />
        <SettingsRow
          title="Speaking speed"
          description="Keeps the voice pitch. Default 1.15×."
          control={
            <div className="flex items-center gap-2">
              <input
                aria-label="Speaking speed"
                type="number"
                min={0.8}
                max={1.5}
                step={0.01}
                value={rate}
                disabled={disabled}
                className={controlClass + " w-24 text-right tabular-nums"}
                onChange={(event) => setRate(event.target.value)}
                onBlur={() => {
                  const value = Number(rate);
                  if (!config) return;
                  if (!Number.isFinite(value) || value < 0.8 || value > 1.5) {
                    setRate(String(config.rate));
                    setError("Speaking speed must be between 0.8× and 1.5×.");
                  } else if (value !== config.rate) configure({ ...config, rate: value });
                }}
              />
              <span className="text-sm text-muted-foreground">×</span>
            </div>
          }
        />
        <SettingsRow
          title="Voice check"
          description="Synthesizes a short sentence through the selected API."
          status={
            check?.state === "error"
              ? (remedies[check.errorClass ?? ""] ??
                "The speech provider could not complete the check. Retry.")
              : undefined
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || config?.synthesis !== "mistral"}
              onClick={() => void run({ action: "speech.settings.check" })}
            >
              {pending ? "Checking…" : "Check voice"}
            </Button>
          }
        >
          {recording && (
            <audio
              ref={audio}
              controls
              src={recording}
              className="mt-2 h-9 w-full"
              onLoadedMetadata={(event) => {
                event.currentTarget.preservesPitch = true;
                event.currentTarget.playbackRate = config?.rate ?? 1.15;
              }}
            />
          )}
        </SettingsRow>
        <SettingsRow
          title="Transcription check"
          description="Checks a short clip from the selected voice. No microphone recording."
          status={
            sttCheck?.state === "error"
              ? (remedies[sttCheck.errorClass ?? ""] ?? "Transcription failed. Retry the check.")
              : sttCheck?.state === "ok"
                ? "Measured from audio end to final transcript; microphone and connection setup are separate."
                : "Not checked — selecting a path does not verify live transcription."
          }
          control={
            <div className="flex items-center gap-3">
              <span
                role="status"
                className="flex items-center gap-1.5 text-xs"
                title={sttCheck ? "Checked " + sttCheck.checkedAt : "No transcription check yet"}
              >
                {sttPending ? (
                  <CircleDashedIcon className="size-4 animate-spin text-muted-foreground" />
                ) : sttCheck?.state === "ok" ? (
                  <CheckIcon className="size-4 text-emerald-500" />
                ) : sttCheck ? (
                  <XIcon className="size-4 text-destructive" />
                ) : (
                  <CircleDashedIcon className="size-4 text-muted-foreground" />
                )}
                {sttPending
                  ? "Checking…"
                  : sttCheck?.state === "ok"
                    ? sttCheck.latencyMs + " ms"
                    : sttCheck?.errorClass ?? "Not checked"}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || config?.transcription !== "mistral" || config?.synthesis !== "mistral"}
                onClick={() => void run({ action: "speech.settings.check.transcription" })}
              >
                Check transcription
              </Button>
            </div>
          }
        >
          {transcript && <p className="mt-2 text-sm">{transcript}</p>}
        </SettingsRow>
      </div>
    </SettingsSection>
  );
}
