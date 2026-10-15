import { Link, useNavigate } from "@tanstack/react-router";
import { OptionSelect } from "../ui/option-select";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AudioLinesIcon,
  CheckIcon,
  CircleDashedIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import type { WorkjetSpeechConfig, WorkjetSpeechSettingsResponse } from "@workjet/contracts";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Row } from "../ui/row";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  requestSpeechSettings,
  speechCheckAudio,
  speechErrorText,
  speechFailureReason,
} from "../../lib/workjetSpeechSettings";
import { markSpeechSupport, speechReadFailureView } from "./speechAvailability";

const SPEECH_RETRY_MS = 5_000;

const controlClass = "h-8 min-w-0 rounded-md border border-border bg-background px-2 text-sm";
export const SPEECH_REMEDIES: Readonly<Record<string, string>> = {
  missing_credential: "Schlüssel fehlt",
  missing_voice: "Keine Stimme gewählt",
  credentials_rejected: "Schlüssel abgelehnt",
  access_denied: "Keine Sprachrechte für diesen Schlüssel",
  quota: "Guthaben aufgebraucht",
  rate_limit: "Ratenlimit erreicht",
  timeout: "Zeitüberschreitung",
  invalid_audio: "Ungültige Aufnahme erhalten",
  invalid_transcript: "Kein Transkript erhalten",
  backend_unavailable: "Vorlesen nutzt nicht Mistral API",
};

/** Anbieter, die `speech.settings` mit eigenem Schlüssel kennt. */
export const SPEECH_PROVIDERS = [{ id: "mistral", label: "Mistral API" }] as const;
type SpeechProviderId = (typeof SPEECH_PROVIDERS)[number]["id"];

function uiLanguage(): "de" | "en" {
  return typeof document !== "undefined" && document.documentElement.lang.startsWith("en")
    ? "en"
    : "de";
}

export function SpeechSettingsPanel() {
  const { selectedId } = useCtoxMode();
  const navigate = useNavigate();
  return (
    <SettingsPageContainer>
      {selectedId ? (
        <InstanceSpeechSettings
          key={selectedId}
          instanceId={selectedId}
          onUnsupported={() => void navigate({ to: "/settings/general", replace: true })}
        />
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

type CheckView = "saved" | "running" | "ok" | "bad" | "idle";

const CHECK_ICONS: Readonly<Record<CheckView, ReactNode>> = {
  running: <LoaderIcon className="size-4 animate-spin text-muted-foreground" />,
  ok: <CheckIcon className="size-4 text-emerald-500" />,
  bad: <XIcon className="size-4 text-destructive" />,
  saved: <CheckIcon className="size-4 text-muted-foreground" />,
  idle: <CircleDashedIcon className="size-4 text-muted-foreground" />,
};

/** Ein Symbol statt „Nicht geprüft“: gespeichert, prüft, ok, fehlerhaft. */
function CheckSymbol({ view, title }: { readonly view: CheckView; readonly title: string }) {
  const icon = CHECK_ICONS[view];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={title}
            data-workjet-speech-check={view}
            className="inline-flex size-6 items-center justify-center"
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup>{title}</TooltipPopup>
    </Tooltip>
  );
}

function checkTitle(
  view: CheckView,
  check: WorkjetSpeechSettingsResponse["ttsCheck"] | undefined,
): string {
  if (view === "saved") return "Gespeichert";
  if (view === "running") return "Prüft";
  if (view === "ok") return `Geprüft · ${check?.latencyMs ?? "—"} ms`;
  if (view === "bad") return SPEECH_REMEDIES[check?.errorClass ?? ""] ?? "Prüfung fehlgeschlagen";
  return "—";
}

export function InstanceSpeechSettings({
  instanceId,
  onUnsupported,
}: {
  readonly instanceId: string;
  readonly onUnsupported: () => void;
}) {
  const [settings, setSettings] = useState<WorkjetSpeechSettingsResponse>();
  const [voices, setVoices] = useState<NonNullable<WorkjetSpeechSettingsResponse["voices"]>>([]);
  const [rate, setRate] = useState("1.15");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [recording, setRecording] = useState<string>();
  const [transcript, setTranscript] = useState<string>();
  // Lesefehler werden still wiederholt; „Zugriff verweigert“ ist die einzige Zeile.
  const [readDenied, setReadDenied] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  /** Konto im Entwurf („+ Hinzufügen“) oder Schlüssel wird ersetzt. */
  const [editing, setEditing] = useState<SpeechProviderId | null>(null);
  const [draft, setDraft] = useState<SpeechProviderId | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
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
      if (active.signal.aborted) return;
      if (input.action !== "speech.settings.read") {
        setError(speechErrorText(failure, uiLanguage()));
        return;
      }
      const view = speechReadFailureView(speechFailureReason(failure));
      if (view === "hide") {
        // The instance's CTOX has no speech settings: the page disappears.
        markSpeechSupport(instanceId, false);
        onUnsupported();
      } else if (view === "denied") {
        setReadDenied(true);
      } else {
        window.setTimeout(() => setReadAttempt((attempt) => attempt + 1), SPEECH_RETRY_MS);
      }
    } finally {
      if (controller.current === active && !active.signal.aborted) setBusy(undefined);
    }
  }

  useEffect(() => {
    void run({ action: "speech.settings.read" }).then((result) => {
      if (result === undefined) return;
      markSpeechSupport(instanceId, true);
      if (result.status.mistral_credential_present) void run({ action: "speech.settings.voices" });
    });
    return () => {
      controller.current?.abort();
      audio.current?.pause();
      if (url.current) URL.revokeObjectURL(url.current);
    };
    // This component is remounted when its instance changes.
  }, [instanceId, readAttempt]);

  useEffect(() => {
    if (audio.current && settings) {
      audio.current.preservesPitch = true;
      audio.current.playbackRate = settings.status.config.rate;
    }
  }, [recording, settings]);

  function configure(config: WorkjetSpeechConfig) {
    return run({ action: "speech.settings.configure", config });
  }

  /**
   * Speichern: Feld leert sich, die Zeile zeigt sofort „gespeichert“, dann
   * prüft sie selbst. Ein neu hinzugefügtes Konto wird zum Vorlesen gewählt.
   */
  async function saveKey(secret: string, added: boolean) {
    setSavedAt(Date.now());
    const saved = await run({ action: "speech.settings.key", secret });
    if (!saved?.status.mistral_credential_present) {
      setSavedAt(null);
      return false;
    }
    setDraft(null);
    setEditing(null);
    let config = saved.status.config;
    if (added && config.synthesis !== "mistral") {
      const next = await configure({ ...config, synthesis: "mistral", transcription: "mistral" });
      if (next) config = next.status.config;
    }
    await run({ action: "speech.settings.voices" });
    if (config.synthesis === "mistral") await run({ action: "speech.settings.check" });
    setSavedAt(null);
    return true;
  }

  const config = settings?.status.config;
  const credential = settings?.status.mistral_credential_present ?? false;
  const check = settings?.ttsCheck;
  const sttCheck = settings?.sttCheck;
  const sttPending = busy === "speech.settings.check.transcription";
  const disabled = busy !== undefined || !config;
  const mistralInUse = config?.synthesis === "mistral" || config?.transcription === "mistral";
  const accountView: CheckView =
    busy === "speech.settings.check"
      ? "running"
      : savedAt !== null
        ? busy === "speech.settings.key"
          ? "saved"
          : "running"
        : check?.state === "ok"
          ? "ok"
          : check
            ? "bad"
            : "idle";
  const showMistral = credential || draft === "mistral";
  const backendOptions = (current: WorkjetSpeechConfig["synthesis"] | undefined) => [
    { value: "runtime", label: "Lokale Laufzeit" },
    ...(credential || current === "mistral" ? [{ value: "mistral", label: "Mistral API" }] : []),
    ...(current === "computer" ? [{ value: "computer" as const, label: "Sprach-Rechner" }] : []),
  ];

  return (
    <SettingsSection
      title="Sprachausgabe"
      id="speech"
      headerAction={
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Aktualisieren"
                  disabled={busy !== undefined}
                  onClick={() => void run({ action: "speech.settings.read" })}
                />
              }
            >
              <RefreshCwIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Aktualisieren</TooltipPopup>
          </Tooltip>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="sm"
                  disabled={!config || busy !== undefined}
                  data-workjet-action="speech.add-provider"
                />
              }
            >
              <PlusIcon className="size-3.5" />
              Hinzufügen
            </MenuTrigger>
            <MenuPopup align="end">
              {SPEECH_PROVIDERS.map((provider) => (
                <MenuItem
                  key={provider.id}
                  disabled={credential}
                  data-workjet-action={`speech.provider.${provider.id}.select`}
                  onClick={() => {
                    setDraft(provider.id);
                    setEditing(provider.id);
                  }}
                >
                  <AudioLinesIcon className="size-4" />
                  {provider.label}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        </div>
      }
    >
      {error && config ? (
        <p role="alert" className="px-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {!config && readDenied ? (
        <p className="px-1 text-sm text-muted-foreground" data-workjet-speech-denied="">
          Keine Berechtigung für Spracheinstellungen
        </p>
      ) : null}
      {config && showMistral ? (
        <div
          className="divide-y divide-border/50 rounded-lg border"
          data-workjet-speech-accounts=""
        >
          <div data-workjet-speech-account="mistral">
            <Row
              className="py-1.5"
              name={
                <span className="flex min-w-0 items-center gap-2">
                  <AudioLinesIcon role="img" aria-label="Mistral API" className="size-4 shrink-0" />
                  <span className="truncate font-medium">Mistral API</span>
                </span>
              }
              meta={
                <span className="pl-6">
                  {credential ? "API-Key" : "—"}
                  {accountView === "bad" ? ` · ${checkTitle("bad", check)}` : ""}
                </span>
              }
              chips={
                credential || savedAt !== null ? (
                  <CheckSymbol view={accountView} title={checkTitle(accountView, check)} />
                ) : undefined
              }
              active={credential && mistralInUse}
              activeDisabled={!credential || disabled}
              activeLabel="Mistral API verwenden"
              onActiveChange={(on) => {
                if (!config) return;
                const backend = on ? "mistral" : "runtime";
                void configure({ ...config, synthesis: backend, transcription: backend });
              }}
              {...(draft === "mistral" && !credential
                ? {
                    onDelete: () => {
                      setDraft(null);
                      setEditing(null);
                    },
                    undoableDelete: true,
                    deleteLabel: "Entfernen",
                  }
                : {})}
              menuActions={
                credential
                  ? [
                      { label: "API-Key ersetzen", onSelect: () => setEditing("mistral") },
                      {
                        label: "Neu prüfen",
                        onSelect: () => void run({ action: "speech.settings.check" }),
                      },
                      {
                        label: "Stimmen laden",
                        onSelect: () => void run({ action: "speech.settings.voices" }),
                      },
                    ]
                  : []
              }
              menuLabel="Aktionen für Mistral API"
            />
            {editing === "mistral" ? (
              <SpeechKeyForm
                replacing={credential}
                busy={busy === "speech.settings.key"}
                onSave={(secret) => saveKey(secret, !credential)}
                onCancel={() => {
                  setEditing(null);
                  if (!credential) setDraft(null);
                }}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      <div
        className="divide-y divide-border rounded-lg border border-border"
        {...(!config ? { "data-workjet-speech-unloaded": "" } : {})}
      >
        <SettingsRow
          title="Vorlesen"
          control={
            <OptionSelect
              aria-label="Vorlesen"
              className="w-full sm:w-64"
              value={config?.synthesis ?? ""}
              placeholder="—"
              disabled={disabled}
              options={backendOptions(config?.synthesis)}
              onValueChange={(next) =>
                config &&
                void configure({ ...config, synthesis: next === "mistral" ? "mistral" : "runtime" })
              }
            />
          }
        />
        <SettingsRow
          title="Transkription"
          control={
            <OptionSelect
              aria-label="Transkription"
              className="w-full sm:w-64"
              value={config?.transcription ?? ""}
              placeholder="—"
              disabled={disabled}
              options={backendOptions(config?.transcription)}
              onValueChange={(next) =>
                config &&
                void configure({
                  ...config,
                  transcription: next === "mistral" ? "mistral" : "runtime",
                })
              }
            />
          }
        />
        <SettingsRow
          title="Stimme"
          control={
            <OptionSelect
              aria-label="Stimme"
              className="w-full sm:w-64"
              value={config?.voice_id ?? ""}
              placeholder={config?.synthesis === "mistral" ? "Stimme wählen" : "—"}
              disabled={disabled || config?.synthesis !== "mistral"}
              options={[
                ...(config?.voice_id && !voices.some((voice) => voice.id === config.voice_id)
                  ? [{ value: config.voice_id, label: "Aktuelle Stimme" }]
                  : []),
                ...voices.map((voice) => ({ value: voice.id, label: voice.name || voice.id })),
              ]}
              onValueChange={(next) =>
                config && void configure({ ...config, voice_id: next || null })
              }
            />
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
                  } else if (value !== config.rate) void configure({ ...config, rate: value });
                }}
              />
              <span className="text-sm text-muted-foreground">×</span>
            </div>
          }
        />
        <SettingsRow
          title="Test"
          control={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || config?.synthesis !== "mistral"}
                onClick={() => void run({ action: "speech.settings.check" })}
              >
                {busy === "speech.settings.check" ? (
                  <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                ) : null}
                Stimme testen
              </Button>
              <span className="flex items-center gap-1">
                {sttCheck || sttPending ? (
                  <CheckSymbol
                    view={sttPending ? "running" : sttCheck?.state === "ok" ? "ok" : "bad"}
                    title={
                      sttPending
                        ? "Prüft"
                        : sttCheck?.state === "ok"
                          ? `Geprüft · ${sttCheck.latencyMs ?? "—"} ms`
                          : (SPEECH_REMEDIES[sttCheck?.errorClass ?? ""] ??
                            "Prüfung fehlgeschlagen")
                    }
                  />
                ) : null}
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
              </span>
            </div>
          }
        >
          {recording ? (
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
          ) : null}
          {transcript ? <p className="mt-2 text-sm">{transcript}</p> : null}
        </SettingsRow>
      </div>
    </SettingsSection>
  );
}

/** Schlüssel-Eingabe inline unter der Kontozeile; das Feld leert sich beim Speichern. */
function SpeechKeyForm({
  replacing,
  busy,
  onSave,
  onCancel,
}: {
  readonly replacing: boolean;
  readonly busy: boolean;
  readonly onSave: (secret: string) => Promise<boolean>;
  readonly onCancel: () => void;
}): ReactNode {
  const [key, setKey] = useState("");
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus({ preventScroll: true }), []);
  return (
    <form
      className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-9"
      data-workjet-speech-key-form=""
      onSubmit={(event) => {
        event.preventDefault();
        // CTOX lehnt Schlüssel mit Rand-Leerzeichen ab; eingefügte Schlüssel tragen oft eins.
        const secret = key.trim();
        if (!secret) return;
        setKey("");
        setFailed(false);
        void onSave(secret).then((ok) => setFailed(!ok));
      }}
    >
      <input
        ref={input}
        aria-label="Mistral-Schlüssel"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        maxLength={4096}
        className={controlClass + " w-full sm:w-72"}
        placeholder={replacing ? "Neuer API-Key" : "API-Key"}
        disabled={busy}
        onChange={(event) => setKey(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
      <Button size="sm" variant="outline" type="button" onClick={onCancel}>
        Abbrechen
      </Button>
      <Button type="submit" size="sm" disabled={busy || key.trim().length === 0}>
        Speichern
      </Button>
      {failed ? (
        <span role="alert" className="w-full text-xs text-destructive">
          Schlüssel nicht gespeichert.
        </span>
      ) : null}
    </form>
  );
}
