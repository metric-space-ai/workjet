import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectId, WorkjetJourFixeReadResponse } from "@workjet/contracts";
import { readActiveWorkjetScope } from "../activeWorkjetScope";
import { JourFixeNativeSession, mapJourFixeMeeting } from "../lib/jourFixeNative";
import {
  readCachedJourFixePresentation,
  readJourFixePresentation,
  saveJourFixePresentationSlide,
  type JourFixePresentation,
} from "../lib/jourFixePresentation";
import type { CanvasScene } from "@workjet/slide-engine/excalidraw/canvas-schema";
import { JourFixeSpeechRoom } from "./JourFixeSpeechRoom";
import type { JourFixeSpeechProvider } from "../lib/jourFixeSpeech";
import { nativeJourFixeNarrationProvider } from "../lib/nativeJourFixeNarrationProvider";
import { createJourFixeGatewayMicrophoneProvider } from "../lib/jourFixeGatewayMicrophone";
import { Button } from "./ui/button";

/** Retained narration plus the owner's microphone through the CTOX speech gateway. */
const nativeJourFixeSpeechProvider = createJourFixeGatewayMicrophoneProvider({
  prepareNarration: nativeJourFixeNarrationProvider.prepareNarration,
});

export function NativeJourFixeRoom(props: {
  readonly instanceId: string;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly onBack: () => void;
  readonly speechProvider?: JourFixeSpeechProvider | undefined;
}) {
  return <NativeJourFixeRoomContent key={`${props.instanceId}:${props.projectId}`} {...props} />;
}
function NativeJourFixeRoomContent({
  instanceId,
  projectId,
  projectTitle,
  onBack,
  speechProvider,
}: Parameters<typeof NativeJourFixeRoom>[0]) {
  const active = useRef(false);
  const readAbort = useRef<AbortController | null>(null);
  const pendingAbort = useRef<AbortController | null>(null);
  const recovery = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  const retrying = useRef(false);
  const [pendingFailed, setPendingFailed] = useState(false);
  const session = useMemo(
    () =>
      new JourFixeNativeSession(
        instanceId,
        projectId,
        () => active.current && readActiveWorkjetScope().selectedInstanceId === instanceId,
      ),
    [instanceId, projectId],
  );
  const [result, setResult] = useState<WorkjetJourFixeReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<JourFixePresentation | null>(null);
  const [presentationReload, setPresentationReload] = useState(0);
  // Die Bibliothek wiederholt bis zu 5 min; erst danach gilt der Stand als
  // endgültig fehlgeschlagen. Solange läuft die Anzeige im Ladezustand.
  const [presentationPending, setPresentationPending] = useState(false);
  const [presentationFailed, setPresentationFailed] = useState(false);
  const meetingId = result?.meeting?.id;
  const deckRevision = result?.meeting?.deck_revision;
  const meetingState = result?.meeting?.state;
  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;
    const controller = new AbortController();
    setPresentationPending(true);
    void readCachedJourFixePresentation(instanceId, projectId, meetingId).then((cached) => {
      if (!cancelled && cached) setPresentation((value) => value ?? cached);
    });
    void readJourFixePresentation(
      instanceId,
      projectId,
      meetingId,
      undefined,
      controller.signal,
    ).then(
      (value) => {
        if (!cancelled) {
          setPresentation(value);
          setPresentationPending(false);
          setPresentationFailed(false);
        }
      },
      () => {
        if (!cancelled) {
          setPresentationPending(false);
          setPresentationFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [instanceId, projectId, meetingId, deckRevision, meetingState, presentationReload]);
  const reloadPresentation = useCallback(() => {
    setPresentationFailed(false);
    setPresentationReload((count) => count + 1);
  }, []);
  const savePresentationSlide = useCallback(
    async (slideId: string, scene: CanvasScene) => {
      if (!presentation) throw new Error("Dieser Termin hat keine Folien.");
      const saved = await saveJourFixePresentationSlide(
        instanceId,
        projectId,
        presentation.manifest,
        slideId,
        scene,
      );
      if (active.current) {
        if (saved.presentation) setPresentation(saved.presentation);
        if (saved.reloadError) setPresentationFailed(true);
      }
    },
    [instanceId, projectId, presentation],
  );
  const refresh = async () => {
    setPresentationReload((count) => count + 1);
    const value = await session.read(result?.meeting?.id, readAbort.current?.signal);
    setResult(value);
    setError(null);
  };
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    readAbort.current = controller;
    let cancelled = false;
    let confirmed = false;
    // Render the last confirmed snapshot at once; CTOX's answer replaces it.
    void session.readCached().then((cached) => {
      if (!cancelled && !confirmed && cached) setResult((value) => value ?? cached);
    });
    void session.read(undefined, controller.signal).then(
      (value) => {
        confirmed = true;
        if (!cancelled) {
          setResult(value);
          setError(null);
        }
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : "Termin nicht verfügbar.");
      },
    );
    return () => {
      cancelled = true;
      active.current = false;
      controller.abort();
      pendingAbort.current?.abort();
      pendingAbort.current = null;
      recovery.current?.reject(
        new Error("Der Termin wurde geschlossen, bevor die Änderung bestätigt war."),
      );
      recovery.current = null;
    };
  }, [session]);
  const meeting = result?.meeting ? mapJourFixeMeeting(result.meeting) : null;
  if (meeting === null)
    return (
      <main
        className="mx-auto w-full max-w-5xl p-6"
        data-workjet-native-meeting-state={error ? "error" : result ? "unprepared" : "loading"}
      >
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← {projectTitle}
        </Button>
        <h1 className="mt-5 text-xl font-semibold">Regeltermin</h1>
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          {error ?? (result ? "Noch kein Termin vorbereitet" : "Termin wird geladen …")}
        </p>
        <Button
          className="mt-4"
          size="sm"
          variant="outline"
          onClick={() =>
            void refresh().catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : "Termin nicht verfügbar."),
            )
          }
        >
          Aktualisieren
        </Button>
      </main>
    );
  async function accepted(action: () => Promise<WorkjetJourFixeReadResponse>) {
    try {
      const value = await action();
      setResult(value);
      setError(null);
    } catch (reason) {
      if (!active.current || !session.hasPendingChange()) throw reason;
      // Unbestätigte Änderung: die Wiederholung läuft automatisch und still im
      // Hintergrund. Entwurf und gesperrte Eingaben bleiben, bis der Beleg da ist.
      const waiting = new Promise<void>((resolve, reject) => {
        recovery.current = { resolve, reject };
      });
      confirmPending();
      await waiting;
    }
  }
  function confirmPending() {
    if (retrying.current) return;
    retrying.current = true;
    setPendingFailed(false);
    const controller = new AbortController();
    pendingAbort.current = controller;
    void session
      .retryPendingUntilConfirmed({ signal: controller.signal })
      .then(
        (value) => {
          if (!active.current) return;
          setResult(value);
          setError(null);
          const waiting = recovery.current;
          recovery.current = null;
          waiting?.resolve();
        },
        () => {
          // Endgültig gescheitert (5 min): erst dann „Nicht gespeichert“ am Element;
          // „Erneut senden“ startet denselben Vorgang mit neuer Frist.
          if (active.current) setPendingFailed(true);
        },
      )
      .finally(() => {
        retrying.current = false;
        if (pendingAbort.current === controller) pendingAbort.current = null;
      });
  }
  // A shown deck (also from the cache) is never covered by a load or refresh status.
  const presentationStatus =
    presentation === null && (presentationFailed || presentationPending)
      ? {
          state: presentationFailed ? ("failed" as const) : ("loading" as const),
          text: presentationFailed ? "Folien nicht verfügbar" : "Folien werden geladen …",
          ...(presentationFailed ? { onRetry: reloadPresentation } : {}),
        }
      : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <JourFixeSpeechRoom
        instanceId={instanceId}
        speechProvider={speechProvider ?? nativeJourFixeSpeechProvider}
        projectTitle={projectTitle}
        meeting={meeting}
        commentDelivery="saved"
        {...(presentationStatus ? { presentationStatus } : {})}
        {...(pendingFailed ? { pendingChange: { onRetry: () => confirmPending() } } : {})}
        {...(presentation
          ? {
              presentation: {
                document: presentation.document,
                editable: ["preparing", "ready", "live", "review"].includes(meeting.state),
                onSave: savePresentationSlide,
              },
            }
          : {})}
        onBack={onBack}
        onRefresh={refresh}
        onStartMeeting={(id, revision) => accepted(() => session.start(id, revision))}
        onEndMeeting={(id, revision) => accepted(() => session.end(id, revision))}
        onMessage={(_, revision, text) =>
          accepted(() => session.text({ ...meeting, revision }, text))
        }
        {...(["live", "review"].includes(meeting.state)
          ? { onComment: (draft, text) => accepted(() => session.comment(draft, text)) }
          : {})}
        onConfirmTodos={(id, revision, proposal, goalRevision) =>
          accepted(() => session.confirm(id, revision, proposal, goalRevision))
        }
        onReviseTodos={(id, revision, proposal, items) =>
          accepted(() => session.revise(id, revision, proposal, items))
        }
      />
    </div>
  );
}
