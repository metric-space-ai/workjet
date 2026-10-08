import {
  CommandId,
  isWorkjetSupervisorReceiptForRequest,
  nextWorkjetSupervisorExecutionPageRequest,
  type WorkjetSupervisorExecutionPage,
  type WorkjetSupervisorExecutionPageRequest,
  type WorkjetSupervisorJournal,
  type WorkjetSupervisorTurnIntent,
} from "@workjet/contracts";
import { useEffect, useRef, useState } from "react";
import { newCommandId } from "~/lib/utils";
import {
  persistSupervisorJournal,
  canResumeSupervisorJournal,
  nativeSupervisorResultText,
  supervisorJournalMatchesScope,
  type NativeSupervisorScope,
} from "../../nativeSupervisorComposer";
import {
  resumeWorkjetSupervisorTurn,
  submitWorkjetSupervisorTurn,
} from "../../workjetSupervisorControl";
import { requestWorkjetProjectControl } from "../../workjetProjectControl";
import { readWorkjetSupervisorExecutionPage } from "../../workjetSupervisorExecution";
import { requestLocalProjectRegistrationRetry } from "../../localProjectRegistration";
import { refreshWorkjetProjectRegistry } from "../../workjetProjectRegistry";
import { NativeSupervisorExecutionDetails } from "./NativeSupervisorExecutionDetails";
import type { WorkjetThreadConfig } from "@workjet/contracts";

export function NativeSupervisorComposer(props: {
  readonly scope: NativeSupervisorScope | null;
  readonly config: WorkjetThreadConfig;
  readonly instanceId: string | null;
  readonly blockReason: string | null;
  readonly unavailable: boolean;
  readonly saveConfig: (config: WorkjetThreadConfig) => Promise<{ readonly _tag: string }>;
}) {
  const [journal, setJournal] = useState<WorkjetSupervisorJournal | null>(() =>
    props.config.schemaVersion === 2 ? (props.config.ctoxSupervisorTurn ?? null) : null,
  );
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [execution, setExecution] = useState<{
    commandId: string;
    request: WorkjetSupervisorExecutionPageRequest;
    page: WorkjetSupervisorExecutionPage;
  } | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const executionRef = useRef(execution);
  executionRef.current = execution;
  const inFlight = useRef(false);
  const restored = useRef(false);
  const journalRef = useRef(journal);
  journalRef.current = journal;
  const scope = props.scope;
  const scopeMatches =
    scope !== null && (journal === null || supervisorJournalMatchesScope(journal, scope));
  const disabled = props.unavailable || !scopeMatches;
  const pending =
    journal !== null && journal.submission !== "not-submitted" && journal.turn?.terminal !== true;
  const latestProps = useRef(props);
  latestProps.current = props;

  const run = async (
    operation: "send" | "resume" | "cancel" | "events",
    pageRequest?: WorkjetSupervisorExecutionPageRequest,
  ) => {
    const current = latestProps.current;
    const target = current.scope;
    const saved = journalRef.current;
    if (
      inFlight.current ||
      current.unavailable ||
      target === null ||
      (saved !== null && !supervisorJournalMatchesScope(saved, target))
    )
      return;
    if (
      operation === "send" &&
      (prompt.trim() === "" ||
        (saved !== null && saved.submission !== "not-submitted" && saved.turn?.terminal !== true))
    )
      return;
    if (operation !== "send" && saved === null) return;
    if (operation === "cancel" && (saved?.turn == null || saved.turn.terminal)) return;
    if (operation === "events" && saved?.turn == null) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setFailureCode(null);
    const port = {
      save: async (next: WorkjetSupervisorJournal) => {
        await persistSupervisorJournal({
          config: current.config,
          journal: next,
          dispatch: current.saveConfig,
        });
        journalRef.current = next;
        setJournal(next);
      },
    };
    try {
      let result;
      if (operation === "send") {
        setExecution(null);
        executionRef.current = null;
        setExecutionError(null);
        const intent: WorkjetSupervisorTurnIntent = {
          ...target,
          commandId: CommandId.make(`supervisor-${newCommandId()}`),
          goal: prompt.trim(),
          createdAt: new Date().toISOString(),
        };
        result = await submitWorkjetSupervisorTurn(intent, port);
      } else if (operation === "resume" && saved !== null) {
        result = await resumeWorkjetSupervisorTurn(
          saved,
          CommandId.make(`observe-${newCommandId()}`),
          port,
        );
      } else if (operation === "cancel" && saved?.turn) {
        const request = {
          action: "project.supervisor.turn.cancel" as const,
          commandId: CommandId.make(`cancel-${newCommandId()}`),
          projectId: target.projectId,
          threadId: target.threadId,
          targetCommandId: saved.turn.commandId,
        };
        result = await requestWorkjetProjectControl(target.instanceId, request);
        if (
          result._tag === "completed" &&
          isWorkjetSupervisorReceiptForRequest(request, result.response) &&
          result.response.action === "project.supervisor.turn.cancel"
        ) {
          await port.save({
            intent: saved.intent,
            turn: result.response.turn,
            submission: "confirmed",
          });
          // This receipt requests cancellation; it never confirms a worker interrupt.
          setNotice("Cancellation requested; waiting for the task receipt.");
        } else if (result._tag === "completed")
          throw new Error("The response belongs to a different task.");
      }
      if (journalRef.current?.turn?.terminal) setNotice(null);
      if (result?._tag === "failed") {
        setFailureCode(result.code);
        setError(`CTOX: ${result.code}. Check the task and reconnect.`);
      }
      if (
        result?._tag === "completed" &&
        (operation === "send" || prompt.trim() === saved?.intent.goal)
      )
        setPrompt("");
      const confirmed = journalRef.current;
      if (
        (operation === "events" || result?._tag === "completed") &&
        confirmed?.submission === "confirmed" &&
        confirmed.turn
      ) {
        const previous = executionRef.current;
        const request =
          pageRequest ?? (previous?.commandId === confirmed.turn.commandId ? previous.request : {});
        // One bounded watch per refresh. Page failures must not stop task observation.
        try {
          const observed = await readWorkjetSupervisorExecutionPage(
            confirmed,
            CommandId.make(`events-${newCommandId()}`),
            port,
            request,
          );
          if (
            observed._tag === "completed" &&
            observed.response.action === "project.supervisor.turn.watch" &&
            observed.response.executionPage
          ) {
            const next = {
              commandId: confirmed.turn.commandId,
              request,
              page: observed.response.executionPage,
            };
            executionRef.current = next;
            setExecution(next);
            setExecutionError(null);
          } else if (observed._tag === "failed") {
            setExecutionError(
              observed.code === "unsupported"
                ? "This CTOX version does not provide execution history."
                : `Execution history unavailable: ${observed.code}. Refresh or load from the start.`,
            );
          }
        } catch {
          setExecutionError("Could not save execution history. Refresh to retry.");
        }
      }
    } catch (failure) {
      setFailureCode("local_failed");
      setError(failure instanceof Error ? failure.message : "Could not confirm the CTOX task.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const runRef = useRef(run);
  runRef.current = run;
  const persistedJournal =
    props.config.schemaVersion === 2 ? (props.config.ctoxSupervisorTurn ?? null) : null;
  useEffect(() => {
    if (!inFlight.current && persistedJournal !== null && persistedJournal !== journalRef.current) {
      journalRef.current = persistedJournal;
      setJournal(persistedJournal);
      setError(null);
      setFailureCode(null);
    }
  }, [persistedJournal]);

  useEffect(() => {
    // Restore pending and terminal turns alike; events are backfilled from the saved identity.
    if (!restored.current && !disabled && journal !== null) {
      restored.current = true;
      if (journal.submission !== "not-submitted") void runRef.current("resume");
    }
  }, [disabled, journal]);
  useEffect(() => {
    if (disabled || busy || !canResumeSupervisorJournal(journal, failureCode)) return;
    const timer = setTimeout(() => {
      void runRef.current("resume");
    }, 3000);
    return () => clearTimeout(timer);
  }, [disabled, busy, failureCode, journal]);

  return (
    <section className="mx-auto w-full max-w-5xl p-3" aria-label="Supervisor task">
      {journal && scopeMatches && (
        <div className="mb-3 max-h-52 overflow-y-auto text-sm" aria-live="polite">
          <p className="whitespace-pre-wrap break-words">{journal.intent.goal}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {journal.turn
              ? `${journal.turn.status} · Attempt ${journal.turn.attempt}`
              : journal.submission === "not-submitted"
                ? "Not sent"
                : "Waiting for CTOX receipt"}
          </p>
          {journal.turn?.taskId && (
            <details className="mt-1 text-xs text-muted-foreground">
              <summary>Task details</summary>
              <p>Task {journal.turn.taskId}</p>
              <p>Command {journal.turn.commandId}</p>
            </details>
          )}
          {journal.turn && (
            <NativeSupervisorExecutionDetails
              page={execution?.commandId === journal.turn.commandId ? execution.page : null}
              error={executionError}
              disabled={disabled || busy}
              onReset={() => {
                void run("events", {});
              }}
              onNext={() => {
                if (
                  execution !== null &&
                  execution.commandId === journal.turn?.commandId &&
                  execution.page.has_more
                )
                  void run("events", nextWorkjetSupervisorExecutionPageRequest(execution.page));
              }}
            />
          )}
          {journal.turn?.result != null && (
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans">
              {nativeSupervisorResultText(journal.turn.result)}
            </pre>
          )}
          {journal.turn?.resultTruncated && (
            <p className="text-xs text-muted-foreground">Result truncated</p>
          )}
          {journal.submission === "not-submitted" && (
            <p role="alert" className="text-destructive">
              CTOX: {journal.submissionError}. You can send a new request.
            </p>
          )}
          {journal.turn?.errorMessage && (
            <p role="alert" className="text-destructive">
              {journal.turn.errorCode}: {journal.turn.errorMessage}
            </p>
          )}
        </div>
      )}
      {disabled && (
        <div
          role="status"
          className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        >
          <span>{props.blockReason ?? "Confirm the project and CTOX connection to send."}</span>
          {props.instanceId !== null && (
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                refreshWorkjetProjectRegistry(props.instanceId);
                requestLocalProjectRegistrationRetry();
              }}
            >
              Retry connection
            </button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run("send");
        }}
        className="flex items-end gap-2"
      >
        <textarea
          aria-label="Message to Supervisor"
          placeholder="Ask the Supervisor …"
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={busy || pending}
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key === "Enter" &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void run("send");
            }
          }}
          className="min-w-0 flex-1 resize-none bg-transparent text-sm outline-none"
        />
        <span
          className="pb-2 text-xs text-muted-foreground"
          title="Execution and model are managed by CTOX"
        >
          CTOX
        </span>
        <button
          type="submit"
          aria-label="Send to Supervisor"
          disabled={disabled || busy || pending || prompt.trim() === ""}
          className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
        >
          Send
        </button>
      </form>
      {journal && (
        <div className="mt-2 flex gap-3 text-xs">
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => {
              void run("resume");
            }}
          >
            Refresh task
          </button>
          {pending && journal.turn && (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => {
                void run("cancel");
              }}
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </section>
  );
}
