import { Link, useNavigate } from "@tanstack/react-router";
import { OptionSelect } from "../ui/option-select";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { CheckIcon, CircleDashedIcon, LoaderIcon, RefreshCwIcon, XIcon } from "lucide-react";
import type { WorkjetSpeechConfig, WorkjetSpeechSettingsResponse } from "@workjet/contracts";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
import { SettingsAddButton, SettingsLoadingRow } from "./settingsAdd";

const SPEECH_RETRY_MS = 5_000;

/** Sprechtempo als Auswahl statt Zahlenfeld mit „ד-Suffix (Audit C 36). */
export const SPEECH_RATES = [0.8, 0.9, 1, 1.1, 1.15, 1.2, 1.3, 1.4, 1.5] as const;
function rateLabel(rate: number): string {
  return `${rate.toLocaleString("de-DE")}×`;
}

/** Anbieterzeichen Mistral (Audit C 37), in den Farben der Marke. */
export function MistralIcon({ className, ...props }: ComponentProps<"svg">) {
  const rows = ["#FFD800", "#FFAF00", "#FF8205", "#FA500F", "#E10500"];
  const cells: ReadonlyArray<ReadonlyArray<number>> = [
    [0, 4],
    [0, 1, 3, 4],
    [0, 2, 4],
    [0, 4],
    [0, 4],
  ];
  return (
    <svg viewBox="0 0 10 10" className={className} {...props}>
      {cells.map((columns, row) =>
        columns.map((column) => (
          <rect
            key={`${row}:${column}`}
            x={column * 2}
            y={row * 2}
            width={2}
            height={2}
            fill={rows[row]}
          />
        )),
      )}
    </svg>
  );
}
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
  if (view === "ok")
    return check?.latencyMs == null ? "Geprüft" : `Geprüft · ${check.latencyMs} ms`;
  if (view === "bad") return SPEECH_REMEDIES[check?.errorClass ?? ""] ?? "Prüfung fehlgeschlagen";
  return "Nicht geprüft";
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
    ...(credential ? [{ value: "mistral", label: "Mistral API" }] : []),
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
      {!config && !readDenied ? (
        <SettingsLoadingRow onRetry={() => setReadAttempt((attempt) => attempt + 1)} />
      ) : null}
      {config && !showMistral ? (
        // Ohne Mistral keine toten Steuerelemente, nur die Zeile „+ Hinzufügen“ (Audit C 6, 38).
        <div
          className="flex items-center rounded-lg border px-3 py-1.5"
          data-workjet-speech-accounts=""
        >
          <SettingsAddButton
            action="speech.add-provider"
            disabled={busy !== undefined}
            options={SPEECH_PROVIDERS.map((provider) => ({
              key: provider.id,
              label: provider.label,
              icon: MistralIcon,
              action: `speech.provider.${provider.id}.select`,
              onSelect: () => {
                setDraft(provider.id);
                setEditing(provider.id);
              },
            }))}
          />
        </div>
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
                  <MistralIcon role="img" aria-label="Mistral API" className="size-4 shrink-0" />
                  <span className="truncate font-medium">Mistral API</span>
                </span>
              }
              {...(credential
                ? {
                    meta: (
                      <span className="pl-6">
                        API-Key
                        {accountView === "bad" ? ` · ${checkTitle("bad", check)}` : ""}
                      </span>
                    ),
                  }
                : {})}
              chips={
                credential || savedAt !== null ? (
                  <CheckSymbol view={accountView} title={checkTitle(accountView, check)} />
                ) : undefined
              }
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
      {config ? (
        <div className="divide-y divide-border rounded-lg border border-border">
          {/* Die Wahl Lokal | Mistral gibt es nur mit Schlüssel (Audit C 15). */}
          {backendOptions(config.synthesis).length > 1 ? (
            <SettingsRow
              title="Vorlesen"
              control={
                <OptionSelect
                  aria-label="Vorlesen"
                  className="w-full sm:w-64"
                  value={config.synthesis}
                  disabled={disabled}
                  options={backendOptions(config.synthesis)}
                  onValueChange={(next) =>
                    void configure({
                      ...config,
                      synthesis: next === "mistral" ? "mistral" : "runtime",
                    })
                  }
                />
              }
            />
          ) : null}
          {backendOptions(config.transcription).length > 1 ? (
            <SettingsRow
              title="Transkription"
              control={
                <OptionSelect
                  aria-label="Transkription"
                  className="w-full sm:w-64"
                  value={config.transcription}
                  disabled={disabled}
                  options={backendOptions(config.transcription)}
                  onValueChange={(next) =>
                    void configure({
                      ...config,
                      transcription: next === "mistral" ? "mistral" : "runtime",
                    })
                  }
                />
              }
            />
          ) : null}
          {config.synthesis === "mistral" ? (
            <SettingsRow
              title="Stimme"
              control={
                <OptionSelect
                  aria-label="Stimme"
                  className="w-full sm:w-64"
                  value={config.voice_id ?? ""}
                  placeholder="Stimme wählen"
                  disabled={disabled}
                  options={[
                    ...(config.voice_id && !voices.some((voice) => voice.id === config.voice_id)
                      ? [{ value: config.voice_id, label: "Aktuelle Stimme" }]
                      : []),
                    ...voices.map((voice) => ({ value: voice.id, label: voice.name || voice.id })),
                  ]}
                  onValueChange={(next) => void configure({ ...config, voice_id: next || null })}
                />
              }
            />
          ) : null}
          <SettingsRow
            title="Sprechtempo"
            control={
              <OptionSelect
                aria-label="Sprechtempo"
                className="w-full sm:w-32"
                value={rate}
                disabled={disabled}
                options={[
                  ...(SPEECH_RATES.some((value) => String(value) === rate)
                    ? []
                    : [{ value: rate, label: rateLabel(Number(rate)) }]),
                  ...SPEECH_RATES.map((value) => ({
                    value: String(value),
                    label: rateLabel(value),
                  })),
                ]}
                onValueChange={(next) => {
                  const value = Number(next);
                  if (Number.isFinite(value) && value !== config.rate)
                    void configure({ ...config, rate: value });
                }}
              />
            }
          />
          {config.synthesis === "mistral" ? (
            <SettingsRow
              title="Test"
              control={
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => void run({ action: "speech.settings.check" })}
                  >
                    {busy === "speech.settings.check" ? (
                      <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                    ) : null}
                    Stimme testen
                  </Button>
                  {config.transcription === "mistral" ? (
                    <span className="flex items-center gap-1">
                      {sttCheck || sttPending ? (
                        <CheckSymbol
                          view={sttPending ? "running" : sttCheck?.state === "ok" ? "ok" : "bad"}
                          title={
                            sttPending
                              ? "Prüft"
                              : sttCheck?.state === "ok"
                                ? sttCheck.latencyMs == null
                                  ? "Geprüft"
                                  : `Geprüft · ${sttCheck.latencyMs} ms`
                                : (SPEECH_REMEDIES[sttCheck?.errorClass ?? ""] ??
                                  "Prüfung fehlgeschlagen")
                          }
                        />
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => void run({ action: "speech.settings.check.transcription" })}
                      >
                        Transkription testen
                      </Button>
                    </span>
                  ) : null}
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
                    event.currentTarget.playbackRate = config.rate;
                  }}
                />
              ) : null}
              {transcript ? <p className="mt-2 text-sm">{transcript}</p> : null}
            </SettingsRow>
          ) : null}
        </div>
      ) : null}
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
      <Input
        nativeInput
        ref={input}
        aria-label="Mistral-Schlüssel"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        maxLength={4096}
        className="w-full sm:w-72"
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
