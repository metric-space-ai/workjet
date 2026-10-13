import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CheckIcon, CircleDashedIcon, RefreshCwIcon, XIcon } from "lucide-react";
import type { WorkjetSpeechConfig, WorkjetSpeechSettingsResponse } from "@workjet/contracts";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  requestSpeechSettings,
  speechCheckAudio,
  speechErrorText,
} from "../../lib/workjetSpeechSettings";

const controlClass = "h-8 min-w-0 rounded-md border border-border bg-background px-2 text-sm";
const remedies: Readonly<Record<string, string>> = {
  missing_credential: "Mistral-Schlüssel fehlt",
  missing_voice: "Keine Stimme gewählt",
  credentials_rejected: "Mistral-Schlüssel abgelehnt",
  access_denied: "Keine Sprachrechte für diesen Schlüssel",
  quota: "Mistral-Guthaben aufgebraucht",
  rate_limit: "Ratenlimit erreicht",
  timeout: "Zeitüberschreitung",
  invalid_audio: "Ungültige Aufnahme erhalten",
  invalid_transcript: "Kein Transkript erhalten",
  backend_unavailable: "Nur über Mistral API",
};

function uiLanguage(): "de" | "en" {
  return typeof document !== "undefined" && document.documentElement.lang.startsWith("en")
    ? "en"
    : "de";
}

export function SpeechSettingsPanel() {
  const { selectedId } = useCtoxMode();
  return (
    <SettingsPageContainer>
      {selectedId ? (
        <InstanceSpeechSettings key={selectedId} instanceId={selectedId} />
      ) : (
        <SettingsSection title="Sprachausgabe" id="speech">
          <SettingsRow
            title="Keine Instanz"
            control={
              <Button size="sm" render={<Link to="/settings/business-os" />}>
                Instanz auswählen
              </Button>
            }
          />
        </SettingsSection>
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
    if (input.action !== "speech.settings.voices") setTranscript(undefined);
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
    } catch (failure) {
      if (!active.signal.aborted) setError(speechErrorText(failure, uiLanguage()));
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
  const unloadedLabel = busy === "speech.settings.read" ? "Lädt …" : "Nicht geladen";
  const loadingSlow = useLoadingSlow(busy === "speech.settings.read");
  return (
    <SettingsSection
      title="Sprachausgabe"
      id="speech"
      headerAction={
        !config ? undefined : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== undefined}
            onClick={() => void run({ action: "speech.settings.read" })}
          >
            <RefreshCwIcon className="size-3.5" /> Aktualisieren
          </Button>
        )
      }
    >
      {error && config && (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {!config ? (
        <div
          role={error ? "alert" : "status"}
          className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground"
          data-workjet-speech-unloaded=""
        >
          <span>
            {busy === "speech.settings.read"
              ? loadingSlow
                ? "Laden dauert länger"
                : "Lädt …"
              : (error ?? "Spracheinstellungen der Instanz nicht geladen")}
          </span>
          {busy === "speech.settings.read" && !loadingSlow ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run({ action: "speech.settings.read" })}
            >
              Erneut laden
            </Button>
          )}
        </div>
      ) : null}
      {config && loadingSlow ? (
        <div role="status" className="flex items-center gap-3 px-4 text-sm text-muted-foreground">
          <span>Laden dauert länger</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void run({ action: "speech.settings.read" })}
          >
            Erneut versuchen
          </Button>
        </div>
      ) : null}
      {config ? (
        <div className="divide-y divide-border rounded-lg border border-border">
          <SettingsRow
            title="Mistral API"
            control={
              <span
                className="flex items-center gap-2 text-xs"
                role="status"
                title={
                  !config
                    ? "Nicht geladen"
                    : check
                      ? "Geprüft " + check.checkedAt
                      : "Noch nicht geprüft"
                }
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
                {!config
                  ? unloadedLabel
                  : pending
                    ? "Prüft …"
                    : checked
                      ? "Stimme geprüft · " + check.latencyMs + " ms"
                      : check
                        ? check.errorClass
                        : "Nicht geprüft"}
              </span>
            }
          />
          <SettingsRow
            title="API-Schlüssel"
            status={
              !settings
                ? "—"
                : settings.status.mistral_credential_present
                  ? "Gespeichert"
                  : "Kein Schlüssel"
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
                  aria-label="Mistral-Schlüssel"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  maxLength={4096}
                  className={controlClass + " w-full sm:w-64"}
                  placeholder={
                    !settings
                      ? "—"
                      : settings.status.mistral_credential_present
                        ? "Schlüssel ersetzen"
                        : "Schlüssel eingeben"
                  }
                  disabled={disabled}
                  onChange={(event) => setKey(event.target.value)}
                />
                <Button type="submit" size="sm" disabled={disabled || key.trim().length === 0}>
                  Speichern
                </Button>
              </form>
            }
          />
          <SettingsRow
            title="Vorlesen"
            control={
              <select
                aria-label="Vorlesen"
                className={controlClass + " w-full sm:w-64"}
                value={config?.synthesis ?? ""}
                disabled={disabled}
                onChange={(event) =>
                  config &&
                  configure({
                    ...config,
                    synthesis: event.target.value === "mistral" ? "mistral" : "runtime",
                  })
                }
              >
                {!config && <option value="">{unloadedLabel}</option>}
                <option value="runtime">Lokale Laufzeit</option>
                <option value="mistral">Mistral API</option>
                {config?.synthesis === "computer" && (
                  <option value="computer">Sprach-Rechner</option>
                )}
              </select>
            }
          />
          <SettingsRow
            title="Transkription"
            control={
              <select
                aria-label="Transkription"
                className={controlClass + " w-full sm:w-64"}
                value={config?.transcription ?? ""}
                disabled={disabled}
                onChange={(event) =>
                  config &&
                  configure({
                    ...config,
                    transcription: event.target.value === "mistral" ? "mistral" : "runtime",
                  })
                }
              >
                {!config && <option value="">{unloadedLabel}</option>}
                <option value="runtime">Lokale Laufzeit</option>
                <option value="mistral">Mistral API</option>
                {config?.transcription === "computer" && (
                  <option value="computer">Sprach-Rechner</option>
                )}
              </select>
            }
          />
          <SettingsRow
            title="Stimme"
            control={
              <div className="flex w-full items-center gap-2">
                <select
                  aria-label="Stimme"
                  className={controlClass + " w-full sm:w-64"}
                  value={config?.voice_id ?? ""}
                  disabled={disabled || config?.synthesis !== "mistral"}
                  onChange={(event) =>
                    config && configure({ ...config, voice_id: event.target.value || null })
                  }
                >
                  <option value="">{config ? "Stimme wählen" : unloadedLabel}</option>
                  {config?.voice_id && !voices.some((voice) => voice.id === config.voice_id) && (
                    <option value={config.voice_id}>Aktuelle Stimme</option>
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
                  Stimmen laden
                </Button>
              </div>
            }
          />
          <SettingsRow
            title="Sprechtempo"
            control={
              <div className="flex items-center gap-2">
                <input
                  aria-label="Sprechtempo"
                  type="number"
                  min={0.8}
                  max={1.5}
                  step={0.01}
                  value={config ? rate : ""}
                  placeholder="—"
                  disabled={disabled}
                  className={controlClass + " w-24 text-right tabular-nums"}
                  onChange={(event) => setRate(event.target.value)}
                  onBlur={() => {
                    const value = Number(rate);
                    if (!config) return;
                    if (!Number.isFinite(value) || value < 0.8 || value > 1.5) {
                      setRate(String(config.rate));
                      setError("Sprechtempo: 0,8× bis 1,5×");
                    } else if (value !== config.rate) configure({ ...config, rate: value });
                  }}
                />
                <span className="text-sm text-muted-foreground">×</span>
              </div>
            }
          />
          <SettingsRow
            title="Stimmtest"
            status={
              check?.state === "error"
                ? (remedies[check.errorClass ?? ""] ?? "Test fehlgeschlagen")
                : undefined
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || config?.synthesis !== "mistral"}
                onClick={() => void run({ action: "speech.settings.check" })}
              >
                {pending ? "Prüft …" : "Stimme testen"}
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
            title="Transkriptionstest"
            status={
              !config
                ? "Nicht geladen"
                : sttCheck?.state === "error"
                  ? (remedies[sttCheck.errorClass ?? ""] ?? "Test fehlgeschlagen")
                  : undefined
            }
            control={
              <div className="flex items-center gap-3">
                <span
                  role="status"
                  className="flex items-center gap-1.5 text-xs"
                  title={
                    !config
                      ? "Nicht geladen"
                      : sttCheck
                        ? "Geprüft " + sttCheck.checkedAt
                        : "Noch nicht geprüft"
                  }
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
                  {!config
                    ? unloadedLabel
                    : sttPending
                      ? "Prüft …"
                      : sttCheck?.state === "ok"
                        ? sttCheck.latencyMs + " ms"
                        : (sttCheck?.errorClass ?? "Nicht geprüft")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    disabled ||
                    config?.transcription !== "mistral" ||
                    config?.synthesis !== "mistral"
                  }
                  onClick={() => void run({ action: "speech.settings.check.transcription" })}
                >
                  Transkription testen
                </Button>
              </div>
            }
          >
            {transcript && <p className="mt-2 text-sm">{transcript}</p>}
          </SettingsRow>
        </div>
      ) : null}
    </SettingsSection>
  );
}

/** Ein Laden endet immer: nach 10 s meldet die Seite „Laden dauert länger“. */
function useLoadingSlow(loading: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [loading]);
  return slow;
}
