import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Loader2Icon, MicIcon, MicOffIcon, SquareIcon } from "lucide-react";
import { ComposerControl } from "./ComposerControl";
import {
  composerErrorLine,
  type ComposerErrorLine as ComposerErrorLineValue,
} from "./composerErrorLineLogic";
import { ComposerDictationStream } from "../../lib/composerDictation";
import { requestSpeechSettings } from "../../lib/workjetSpeechSettings";
import {
  captureJourFixeMicrophone,
  type JourFixeMicrophoneCapture,
} from "../../lib/jourFixeBrowserMicrophone";

type DictationSession = {
  controller: AbortController;
  stream: ComposerDictationStream;
  capture?: JourFixeMicrophoneCapture;
  timer?: ReturnType<typeof setTimeout>;
  finishing?: boolean;
};

export function ComposerDictationButton(props: {
  readonly instanceId: string | null;
  readonly disabled?: boolean;
  readonly onTranscript: (text: string) => void;
  /**
   * Meldet den Fehler als Composer-Fehlerzeile an den Composer; `null` räumt
   * sie weg. Ohne Empfänger zeigt der Knopf den Fehler nur am Icon (Tooltip).
   */
  readonly onErrorLine?: ((line: ComposerErrorLineValue | null) => void) | undefined;
}) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "finishing">("idle");
  const currentProps = useRef(props);
  currentProps.current = props;
  const [error, setErrorState] = useState<ComposerErrorLineValue | null>(null);
  const setError = (line: ComposerErrorLineValue | null) => {
    setErrorState(line);
    currentProps.current.onErrorLine?.(line);
  };
  const session = useRef<DictationSession | null>(null);
  const settings = () => {
    void navigate({ to: "/settings/speech" });
  };
  const dispose = () => {
    const current = session.current;
    session.current = null;
    if (!current) return;
    clearTimeout(current.timer);
    current.controller.abort();
    current.capture?.cancel();
    current.stream.cancel();
  };
  useEffect(() => {
    setPhase("idle");
    setError(null);
    return () => dispose();
  }, [props.instanceId]);
  const fail = (reason: unknown) => {
    dispose();
    setPhase("idle");
    // Eine deutsche Zeile als Composer-Fehlerzeile; der Rohtext erscheint nie.
    const line = composerErrorLine(reason ?? "Diktat fehlgeschlagen", {
      fallback: "Diktat fehlgeschlagen",
      unreachableForMs: Number.POSITIVE_INFINITY,
    });
    // Die eine Aktion der Zeile führt in die Spracheinstellungen.
    setError(line ? { ...line, actionLabel: "Spracheinstellungen" } : null);
  };
  const finish = async () => {
    const current = session.current;
    if (!current?.capture || current.finishing) return;
    current.finishing = true;
    clearTimeout(current.timer);
    setPhase("finishing");
    try {
      await current.capture.finish();
      const text = await current.stream.finish();
      if (session.current !== current || current.controller.signal.aborted) return;
      currentProps.current.onTranscript(text);
      dispose();
      setPhase("idle");
    } catch (reason) {
      if (session.current === current) fail(reason);
    }
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const start = async () => {
    if (session.current) return;
    if (!props.instanceId) return settings();
    if (props.disabled) return;
    setError(null);
    setPhase("starting");
    const controller = new AbortController();
    const current: DictationSession = {
      controller,
      stream: new ComposerDictationStream(props.instanceId, controller.signal),
    };
    session.current = current;
    try {
      const response = await requestSpeechSettings(
        props.instanceId,
        { action: "speech.settings.read" },
        controller.signal,
      );
      if (session.current !== current) return;
      if (
        response.status.stt !== "available" ||
        (response.status.config.transcription === "mistral" &&
          !response.status.mistral_credential_present)
      ) {
        dispose();
        setPhase("idle");
        settings();
        return;
      }
      await current.stream.open();
      if (session.current !== current) return;
      current.capture = await captureJourFixeMicrophone({
        signal: controller.signal,
        onFrame: ({ pcm }) => {
          try {
            current.stream.write(pcm);
          } catch (reason) {
            if (session.current === current) fail(reason);
          }
        },
        onError: (reason) => {
          if (session.current === current) fail(reason);
        },
      });
      if (session.current !== current) {
        current.capture.cancel();
        return;
      }
      setPhase("recording");
      current.timer = setTimeout(() => {
        void finishRef.current();
      }, 60_000);
    } catch (reason) {
      if (session.current === current) fail(reason);
    }
  };
  const stateLabel =
    phase === "recording"
      ? "Diktat beenden"
      : phase === "starting"
        ? "Mikrofon verbindet"
        : phase === "finishing"
          ? "Wird transkribiert"
          : error
            ? error.text
            : "Diktieren";
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <ComposerControl
        type="button"
        className="size-7 justify-center px-0"
        aria-label={stateLabel}
        aria-pressed={phase === "recording"}
        aria-busy={phase === "starting" || phase === "finishing" || undefined}
        data-dictation-phase={phase}
        disabled={
          (props.disabled && props.instanceId !== null && phase !== "recording") ||
          phase === "starting" ||
          phase === "finishing"
        }
        title={stateLabel}
        onClick={() =>
          phase === "recording"
            ? finish()
            : error && !props.onErrorLine
              ? settings()
              : start()
        }
      >
        {phase === "recording" ? (
          <SquareIcon className="size-4 animate-status-pulse text-destructive" />
        ) : phase === "starting" || phase === "finishing" ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : error && !props.onErrorLine ? (
          <MicOffIcon className="size-4 text-destructive" />
        ) : (
          <MicIcon className="size-4" />
        )}
      </ComposerControl>
    </span>
  );
}

/** Aktion der Diktat-Fehlerzeile: in die Spracheinstellungen. */
export const DICTATION_SETTINGS_ROUTE = "/settings/speech" as const;
