import { useEffect, useRef, useState } from "react";
import { JourFixeRoom, type JourFixeRoomProps } from "./JourFixeRoom";
import {
  JourFixeSpeechSession,
  type JourFixeSpeechAudio,
  type JourFixeSpeechProvider,
} from "../lib/jourFixeSpeech";
import { JourFixeReadError } from "../lib/jourFixeReadRetry";
import type { JourFixePartialTranscript } from "../lib/jourFixeRoom";

/** Sichtbarer Ton-Zustand: die Bibliothek meldet nur Fehlercodes, der Raum formuliert. */
interface SpeechErrorView {
  readonly text: string;
  readonly canRetry: boolean;
}

/**
 * Transport-Fehlercodes des Ton-Lesens (timeout, request_timeout, guest_failed,
 * unsupported …) werden auf einen kurzen deutschen Zustand abgebildet; nur er
 * darf erneut geladen werden. Mikrofon- und Integritätsfehler bleiben unverändert.
 */
export function jourFixeSpeechErrorView(error: Error): SpeechErrorView {
  if (error instanceof JourFixeReadError) return { text: "Ton nicht verfügbar", canRetry: true };
  return { text: error.message, canRetry: false };
}

type Props = JourFixeRoomProps & {
  readonly instanceId: string;
  readonly speechProvider?: JourFixeSpeechProvider | undefined;
};

/** The installed desktop may inject a signed local helper; other clients use the gateway. */
export function JourFixeSpeechRoom({ speechProvider, ...props }: Props) {
  return speechProvider ? (
    <SpeechRoom {...props} provider={speechProvider} />
  ) : (
    <JourFixeRoom {...props} />
  );
}

function SpeechRoom({
  instanceId,
  provider,
  ...props
}: Omit<Props, "speechProvider"> & {
  readonly provider: JourFixeSpeechProvider;
}) {
  const { meeting } = props;
  const scopeKey = JSON.stringify([
    instanceId,
    meeting.projectId,
    meeting.id,
    meeting.deckRevision,
    meeting.state,
    provider.kind,
  ]);
  const session = useRef<JourFixeSpeechSession | null>(null);
  const refresh = useRef(props.onRefresh);
  useEffect(() => {
    refresh.current = props.onRefresh;
  }, [props.onRefresh]);
  const [speech, setSpeech] = useState<{
    key: string;
    provider?: JourFixeSpeechProvider;
    microphone?: boolean;
    partial?: JourFixePartialTranscript | undefined;
    audio?: JourFixeSpeechAudio | undefined;
    error?: SpeechErrorView | undefined;
  }>({ key: "" });
  const [selectedSlide, setSelectedSlide] = useState("");
  const slideId = meeting.slides.some((slide) => slide.id === selectedSlide)
    ? selectedSlide
    : [...meeting.slides].sort((a, b) => a.position - b.position)[0]?.id;
  useEffect(() => {
    let active = true;
    function change(patch: Partial<Omit<typeof speech, "key">>) {
      if (active)
        setSpeech((current) => ({
          ...(current.key === scopeKey && current.provider === provider ? current : {}),
          key: scopeKey,
          provider,
          ...patch,
        }));
    }
    const value = new JourFixeSpeechSession(
      provider,
      {
        instanceId,
        projectId: meeting.projectId,
        meetingId: meeting.id,
        deckRevision: meeting.deckRevision,
      },
      {
        onMicrophone: (microphone) =>
          change({ microphone, ...(microphone ? { error: undefined } : {}) }),
        onPartial: (partial) => change({ partial }),
        onAudio: (audio) => change({ audio }),
        onCommitted: () => {
          void refresh
            .current?.()
            .catch(() =>
              change({ error: { text: "Transkript nicht aktualisiert", canRetry: false } }),
            );
        },
        onError: (error) => change({ error: jourFixeSpeechErrorView(error) }),
      },
    );
    session.current = value;
    return () => {
      active = false;
      value.close();
      if (session.current === value) session.current = null;
    };
  }, [provider, instanceId, meeting.projectId, meeting.id, meeting.deckRevision, scopeKey]);
  useEffect(() => {
    if (slideId && ["ready", "live", "review"].includes(meeting.state))
      void session.current?.prepareNarration(slideId);
  }, [provider, scopeKey, slideId, meeting.state]);
  const current = speech.key === scopeKey && speech.provider === provider ? speech : undefined;
  // Solange die Bibliothek den Ton (mit Wiederholungen) liest, steht ein ruhiger
  // Ladezustand am Player; die Fehlerzeile kommt erst nach dem endgültigen Fehlschlag.
  const narrationExpected =
    slideId !== undefined && ["ready", "live", "review"].includes(meeting.state);
  const audioCurrent =
    current?.audio !== undefined && slideId !== undefined && current.audio.slideId === slideId;
  const retryNarration = () => {
    const id = slideId;
    if (!id) return;
    setSpeech((state) => ({ ...state, error: undefined }));
    void session.current?.prepareNarration(id);
  };
  const narrationStatus = current?.error
    ? {
        state: "failed" as const,
        text: current.error.text,
        ...(current.error.canRetry && slideId ? { onRetry: retryNarration } : {}),
      }
    : narrationExpected && !audioCurrent
      ? { state: "loading" as const, text: "Ton wird geladen …" }
      : undefined;
  return (
    <JourFixeRoom
      {...props}
      {...(narrationStatus ? { narrationStatus } : {})}
      {...(current?.audio ? { audio: current.audio } : {})}
      partialTranscript={current?.partial}
      microphoneActive={current?.microphone === true}
      {...(meeting.state === "live" && provider.microphoneAvailable !== false
        ? { onToggleMicrophone: () => void session.current?.toggleMicrophone() }
        : {})}
      onSlideChange={(id) => {
        setSelectedSlide(id);
        props.onSlideChange?.(id);
      }}
    />
  );
}
