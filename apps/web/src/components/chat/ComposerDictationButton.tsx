import { useEffect, useRef, useState } from "react";
import { MicIcon, SquareIcon } from "lucide-react";
import { ComposerControl } from "./ComposerControl";
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
}) {
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "finishing">("idle");
  const [error, setError] = useState<string | null>(null);
  const session = useRef<DictationSession | null>(null);
  const currentProps = useRef(props);
  currentProps.current = props;
  const settings = () => {
    window.location.hash = "#/settings/speech";
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
    setError(reason instanceof Error ? reason.message : "Dictation failed. Open Speech settings.");
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
    if (session.current || props.disabled) return;
    if (!props.instanceId) return settings();
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
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <ComposerControl
        type="button"
        className="size-7 justify-center px-0"
        aria-label={phase === "recording" ? "Stop dictation" : "Dictate message"}
        aria-pressed={phase === "recording"}
        disabled={
          (props.disabled && phase !== "recording") || phase === "starting" || phase === "finishing"
        }
        title={phase === "recording" ? "Stop dictation" : "Dictate message"}
        onClick={() => (phase === "recording" ? finish() : start())}
      >
        {phase === "recording" ? (
          <SquareIcon className="size-4 text-red-500" />
        ) : (
          <MicIcon className="size-4" />
        )}
      </ComposerControl>
      {phase !== "idle" ? (
        <span
          role="status"
          className="absolute bottom-full right-0 mb-1 whitespace-nowrap rounded bg-popover px-2 py-1 text-xs"
        >
          {phase === "recording"
            ? "Listening…"
            : phase === "starting"
              ? "Connecting microphone…"
              : "Transcribing…"}
        </span>
      ) : null}
      {error ? (
        <span
          role="alert"
          className="absolute bottom-full right-0 mb-1 w-64 rounded border bg-popover p-2 text-xs"
        >
          {error}{" "}
          <button type="button" className="underline" onClick={settings}>
            Speech settings
          </button>
        </span>
      ) : null}
    </span>
  );
}
