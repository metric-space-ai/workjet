import {
  CommandId,
  isWorkjetSupervisorReceiptForRequest,
  nextWorkjetSupervisorExecutionPageRequest,
  type WorkjetSupervisorExecutionPage,
  type WorkjetSupervisorExecutionEvent,
  type WorkjetSupervisorExecutionPageRequest,
  type WorkjetSupervisorJournal,
  type WorkjetSupervisorTurnIntent,
} from "@workjet/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  appendSupervisorExecutionEvents,
  reconstructSupervisorPublicReplies,
} from "../../supervisorPublicReplies";
import { NativeSupervisorConversation } from "./NativeSupervisorConversation";
import { SupervisorMarkdown } from "./SupervisorMarkdown";
import { newCommandId } from "~/lib/utils";
import {
  persistSupervisorJournal,
  canResumeSupervisorJournal,
  nativeSupervisorResultText,
  supervisorJournalMatchesScope,
  type NativeSupervisorScope,
} from "../../nativeSupervisorComposer";
import {
  bindWorkjetSupervisor,
  resumeWorkjetSupervisorTurn,
  submitWorkjetSupervisorTurn,
} from "../../workjetSupervisorControl";
import {
  requestWorkjetProjectControl,
  describeWorkjetProjectControlFailure,
} from "../../workjetProjectControl";
import { readWorkjetSupervisorPublicExecutionPage } from "../../workjetSupervisorExecution";
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
  readonly conversationTarget?: HTMLElement | null;
}) {
  const [journal, setJournal] = useState<WorkjetSupervisorJournal | null>(() =>
    props.config.schemaVersion === 2 ? (props.config.ctoxSupervisorTurn ?? null) : null,
  );
  const [prompt, setPrompt] = useState("");
  const [bindingRetry, setBindingRetry] = useState(0);
  const [binding, setBinding] = useState<{
    readonly scope: NativeSupervisorScope;
    readonly pending: boolean;
    readonly error: string | null;
    readonly authenticationRequired: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bindingMatches =
    binding !== null &&
    props.scope !== null &&
    binding.scope.instanceId === props.scope.instanceId &&
    binding.scope.projectId === props.scope.projectId &&
    binding.scope.threadId === props.scope.threadId;
  const bindingPending = bindingMatches && binding.pending;
  const [execution, setExecution] = useState<{
    commandId: string;
    request: WorkjetSupervisorExecutionPageRequest;
    page: WorkjetSupervisorExecutionPage;
    taskAttempt: number;
    events: readonly WorkjetSupervisorExecutionEvent[];
    historyLimited: boolean;
  } | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const publicReplies = useMemo(
    () =>
      execution?.page.attempt
        ? reconstructSupervisorPublicReplies(execution.page.attempt.attempt_id, execution.events)
        : [],
    [execution],
  );
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
  const pending = canResumeSupervisorJournal(journal, null);
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
    if (operation === "send" && (prompt.trim() === "" || canResumeSupervisorJournal(saved, null)))
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
        setError(describeWorkjetProjectControlFailure(result, target.instanceId));
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
        const sameTaskAttempt =
          previous !== null &&
          previous.commandId === confirmed.turn.commandId &&
          previous.taskAttempt === confirmed.turn.attempt;
        const request =
          pageRequest ??
          (sameTaskAttempt
            ? nextWorkjetSupervisorExecutionPageRequest(previous.page)
            : { include_public_text: true });
        // One bounded watch per refresh. Page failures must not stop task observation.
        try {
          const observed = await readWorkjetSupervisorPublicExecutionPage(
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
            const currentScope = latestProps.current.scope;
            if (
              !currentScope ||
              currentScope.instanceId !== target.instanceId ||
              currentScope.projectId !== target.projectId ||
              currentScope.threadId !== target.threadId
            )
              return;
            const page = observed.response.executionPage;
            const prior =
              pageRequest?.cursor === undefined && operation === "events" ? null : previous;
            const sameAttempt =
              prior !== null &&
              prior.commandId === confirmed.turn.commandId &&
              prior.page.attempt?.attempt_id === page.attempt?.attempt_id;
            const appended = appendSupervisorExecutionEvents(
              sameAttempt ? prior.events : [],
              page.events,
            );
            const historyLimited = (sameAttempt && prior.historyLimited) || appended.limited;
            const next = {
              commandId: confirmed.turn.commandId,
              request,
              page,
              taskAttempt: observed.response.turn.attempt,
              events: appended.events,
              historyLimited,
            };
            executionRef.current = next;
            setExecution(next);
            setExecutionError(
              appended.conflicted
                ? "Execution history contains conflicting retained events. Reload from the start."
                : null,
            );
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

  const bindingInstanceId = props.scope?.instanceId;
  const bindingProjectId = props.scope?.projectId;
  const bindingThreadId = props.scope?.threadId;
  useEffect(() => {
    if (disabled || !bindingInstanceId || !bindingProjectId || !bindingThreadId) return;
    const scope = {
      instanceId: bindingInstanceId,
      projectId: bindingProjectId,
      threadId: bindingThreadId,
    };
    let stale = false;
    setBinding({ scope, pending: true, error: null, authenticationRequired: false });
    // Stable identity makes remounts and a lost setup reply the same native operation.
    void bindWorkjetSupervisor(
      scope,
      CommandId.make(`supervisor-setup:${bindingProjectId}:${bindingThreadId}`),
    )
      .then((result) => {
        if (stale) return;
        setBinding({
          scope,
          pending: false,
          error:
            result._tag === "failed"
              ? describeWorkjetProjectControlFailure(result, scope.instanceId)
              : null,
          authenticationRequired:
            result._tag === "failed" && result.code === "authentication_required",
        });
      })
      .catch(() => {
        if (!stale)
          setBinding({
            scope,
            pending: false,
            error: "Could not connect the Supervisor. Retry connection.",
            authenticationRequired: false,
          });
      });
    return () => {
      stale = true;
    };
  }, [bindingInstanceId, bindingProjectId, bindingThreadId, disabled, bindingRetry]);

  useEffect(() => {
    // Restore pending and terminal turns alike; events are backfilled from the saved identity.
    if (!restored.current && !disabled && journal !== null) {
      restored.current = true;
      if (journal.turn !== null || canResumeSupervisorJournal(journal, null))
        void runRef.current("resume");
    }
  }, [disabled, journal]);
  useEffect(() => {
    if (disabled || busy || !canResumeSupervisorJournal(journal, failureCode)) return;
    const timer = setTimeout(() => {
      void runRef.current("resume");
    }, 3000);
    return () => clearTimeout(timer);
  }, [disabled, busy, failureCode, journal]);

  useEffect(() => {
    if (disabled || busy || !execution?.page.has_more || execution.historyLimited) return;
    // Backfill retained pages without another turn. One request at a time; a forward native cursor is required.
    const timer = setTimeout(
      () =>
        void runRef.current("events", nextWorkjetSupervisorExecutionPageRequest(execution.page)),
      100,
    );
    return () => clearTimeout(timer);
  }, [disabled, busy, execution]);

  const followReply = useRef(true);
  useEffect(() => {
    const target = props.conversationTarget;
    if (!target) return;
    followReply.current = true;
    const onScroll = () => {
      followReply.current = target.scrollHeight - target.scrollTop - target.clientHeight < 96;
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [props.conversationTarget]);
  useEffect(() => {
    const target = props.conversationTarget;
    if (target && followReply.current) target.scrollTop = target.scrollHeight;
  }, [props.conversationTarget, publicReplies, journal]);

  const conversation =
    journal && scopeMatches ? (
      <NativeSupervisorConversation
        journal={journal}
        page={
          execution !== null && execution.commandId === journal.turn?.commandId
            ? execution.page
            : null
        }
        replies={
          execution !== null && execution.commandId === journal.turn?.commandId ? publicReplies : []
        }
        historyLimited={execution?.historyLimited ?? false}
        error={executionError}
        disabled={disabled || busy}
        onReset={() => void run("events", { include_public_text: true })}
        onNext={() => {
          if (execution)
            void run("events", nextWorkjetSupervisorExecutionPageRequest(execution.page));
        }}
      />
    ) : null;

  return (
    <section className="mx-auto w-full max-w-5xl p-3" aria-label="Supervisor task">
      {props.conversationTarget && conversation
        ? createPortal(conversation, props.conversationTarget)
        : null}
      {journal && scopeMatches && !props.conversationTarget && (
        <div className="mb-3 max-h-52 overflow-y-auto text-sm" aria-live="polite">
          <p className="whitespace-pre-wrap break-words">{journal.intent.goal}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {journal.turn
              ? `${journal.turn.status} · Attempt ${journal.turn.attempt}`
              : journal.submission === "not-submitted" && !pending
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
                void run("events", { include_public_text: true });
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
            <SupervisorMarkdown
              text={nativeSupervisorResultText(journal.turn.result, journal.turn)}
            />
          )}
          {journal.turn?.resultTruncated && (
            <p className="text-xs text-muted-foreground">Result truncated</p>
          )}
          {journal.submission === "not-submitted" && !pending && (
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
      {bindingMatches && binding.error && (
        <div role="alert" className="mb-2 flex items-center gap-2 text-xs text-destructive">
          <span>{binding.error}</span>
          <button
            type="button"
            className="underline underline-offset-2"
            disabled={busy || bindingPending}
            onClick={() => {
              refreshWorkjetProjectRegistry(props.instanceId);
              requestLocalProjectRegistrationRetry();
              setBindingRetry((value) => value + 1);
            }}
          >
            Retry connection
          </button>
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
      {props.instanceId?.startsWith("managed:") &&
        ((bindingMatches && binding.authenticationRequired) ||
          failureCode === "authentication_required" ||
          journal?.submissionError === "authentication_required" ||
          props.blockReason?.startsWith("Sign in to ctox.dev")) && (
          <button
            type="button"
            className="mb-2 text-xs underline underline-offset-2"
            disabled={busy}
            onClick={async () => {
              const bridge = window.desktopBridge?.ctox;
              if (!bridge || inFlight.current) return;
              inFlight.current = true;
              setBusy(true);
              try {
                const result = await bridge.login();
                if (result._tag === "completed") {
                  refreshWorkjetProjectRegistry(latestProps.current.instanceId);
                  requestLocalProjectRegistrationRetry();
                  setError(null);
                  setFailureCode(null);
                  setBindingRetry((value) => value + 1);
                }
              } catch {
                setError("Could not open CTOX sign-in. Retry connection.");
              } finally {
                inFlight.current = false;
                setBusy(false);
              }
            }}
          >
            Sign in to ctox.dev
          </button>
        )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!bindingPending) void run("send");
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
              if (!bindingPending) void run("send");
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
          disabled={disabled || busy || bindingPending || pending || prompt.trim() === ""}
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
