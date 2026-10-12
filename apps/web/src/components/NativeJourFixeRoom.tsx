import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectId, WorkjetJourFixeReadResponse } from "@workjet/contracts";
import { readActiveWorkjetScope } from "../activeWorkjetScope";
import { JourFixeNativeSession, mapJourFixeMeeting } from "../lib/jourFixeNative";
import {
  readJourFixePresentation,
  saveJourFixePresentationSlide,
  type JourFixePresentation,
} from "../lib/jourFixePresentation";
import type { CanvasScene } from "@workjet/slide-engine/excalidraw/canvas-schema";
import { JourFixeSpeechRoom } from "./JourFixeSpeechRoom";
import type { JourFixeSpeechProvider } from "../lib/jourFixeSpeech";
import { nativeJourFixeNarrationProvider } from "../lib/nativeJourFixeNarrationProvider";
import { Button } from "./ui/button";

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
  const recovery = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  const retrying = useRef(false);
  const [retryBusy, setRetryBusy] = useState(false);
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
      if (!presentation) throw new Error("This meeting has no presentation.");
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
    void session.read(undefined, controller.signal).then(
      (value) => {
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
      recovery.current?.reject(new Error("Meeting closed before the change was confirmed."));
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
      setError(reason instanceof Error ? reason.message : "Änderung nicht bestätigt.");
      // Keep the original room action pending, inputs frozen and draft intact.
      await new Promise<void>((resolve, reject) => {
        recovery.current = { resolve, reject };
      });
    }
  }
  async function retry() {
    if (retrying.current) return;
    retrying.current = true;
    setRetryBusy(true);
    try {
      const value = await session.retryPending();
      setResult(value);
      setError(null);
      const pending = recovery.current;
      recovery.current = null;
      pending?.resolve();
    } catch (reason) {
      if (active.current)
        setError(reason instanceof Error ? reason.message : "Änderung unbestätigt.");
    } finally {
      retrying.current = false;
      if (active.current) setRetryBusy(false);
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {presentationFailed ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-destructive/30 px-4 py-2 text-xs text-destructive"
          data-workjet-presentation-state="failed"
        >
          <span className="min-w-0 flex-1">Folien nicht verfügbar</span>
          <Button size="sm" variant="outline" onClick={reloadPresentation}>
            Erneut laden
          </Button>
        </div>
      ) : presentationPending && presentation === null ? (
        <p
          role="status"
          className="border-b border-border px-4 py-2 text-xs text-muted-foreground"
          data-workjet-presentation-state="loading"
        >
          Folien werden geladen …
        </p>
      ) : null}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs"
        >
          <span className="min-w-0 flex-1">{error}</span>
          {session.hasPendingChange() && (
            <Button size="sm" variant="outline" disabled={retryBusy} onClick={() => void retry()}>
              Erneut versuchen
            </Button>
          )}
        </div>
      )}
      <JourFixeSpeechRoom
        instanceId={instanceId}
        speechProvider={speechProvider ?? nativeJourFixeNarrationProvider}
        projectTitle={projectTitle}
        meeting={meeting}
        commentDelivery="saved"
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
