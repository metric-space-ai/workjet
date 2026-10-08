import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectId, WorkjetJourFixeReadResponse } from "@workjet/contracts";
import { readActiveWorkjetScope } from "../activeWorkjetScope";
import { JourFixeNativeSession, mapJourFixeMeeting } from "../lib/jourFixeNative";
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
  const refresh = async () => {
    const value = await session.read(result?.meeting?.id);
    setResult(value);
    setError(null);
  };
  useEffect(() => {
    active.current = true;
    let cancelled = false;
    void session.read().then(
      (value) => {
        if (!cancelled) {
          setResult(value);
          setError(null);
        }
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Meeting unavailable.");
      },
    );
    return () => {
      cancelled = true;
      active.current = false;
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
        <h1 className="mt-5 text-xl font-semibold">Jour fixe</h1>
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          {error ??
            (result ? "No meeting has been prepared for this project yet." : "Loading meeting…")}
        </p>
        <Button
          className="mt-4"
          size="sm"
          variant="outline"
          onClick={() =>
            void refresh().catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : "Meeting unavailable."),
            )
          }
        >
          Refresh
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
      setError(reason instanceof Error ? reason.message : "This change has not been confirmed.");
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
        setError(reason instanceof Error ? reason.message : "Change remains unconfirmed.");
    } finally {
      retrying.current = false;
      if (active.current) setRetryBusy(false);
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs"
        >
          <span className="min-w-0 flex-1">{error}</span>
          {session.hasPendingChange() && (
            <Button size="sm" variant="outline" disabled={retryBusy} onClick={() => void retry()}>
              Retry change
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
