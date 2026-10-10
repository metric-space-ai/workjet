import {
  CommandId,
  isWorkjetSupervisorReceiptForRequest,
  nextWorkjetSupervisorExecutionPageRequest,
  type WorkjetSupervisorExecutionPage,
  type WorkjetSupervisorExecutionEvent,
  type WorkjetSupervisorExecutionPageRequest,
  type WorkjetSupervisorJournal,
  type WorkjetSupervisorTurnIntent,
  type WorkjetSupervisorTurnKind,
} from "@workjet/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpIcon, PlusIcon } from "lucide-react";
import { ComposerBar } from "./ComposerBar";
import { ComposerDictationButton } from "./ComposerDictationButton";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControl } from "./ComposerControl";
import { shouldSubmitComposerOnEnter } from "../../composer-logic";
import { createPortal } from "react-dom";
import {
  appendSupervisorExecutionEvents,
  reconstructSupervisorPublicReplies,
} from "../../supervisorPublicReplies";
import { NativeSupervisorConversation } from "./NativeSupervisorConversation";
import { SupervisorMarkdown } from "./SupervisorMarkdown";
import {
  SupervisorTurnKindPicker,
  supervisorConversationSupported,
  type ScopedSupervisorTurnCapabilities,
} from "./SupervisorTurnKindPicker";
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
  readWorkjetSupervisorTurnCapabilities,
} from "../../workjetSupervisorControl";
import {
  readWorkjetSupervisorInputCapabilities,
  submitWorkjetSupervisorInput,
} from "../../workjetSupervisorInput";
import {
  requestWorkjetProjectControl,
  describeWorkjetProjectControlFailure,
} from "../../workjetProjectControl";
import { readWorkjetSupervisorPublicExecutionPage } from "../../workjetSupervisorExecution";
import { requestLocalProjectRegistrationRetry } from "../../localProjectRegistration";
import { refreshWorkjetProjectRegistry } from "../../workjetProjectRegistry";
import { NativeSupervisorExecutionDetails } from "./NativeSupervisorExecutionDetails";
import type { WorkjetThreadConfig } from "@workjet/contracts";

import { useSupervisorRouteDisplay } from "./useSupervisorRouteDisplay";
import { supervisorRouteLabel } from "../../workjetSupervisorRoute";
import { NativeSupervisorRouteControls } from "./NativeSupervisorRouteControls";
import { NativeSupervisorActualRoute } from "./NativeSupervisorActualRoute";

export function NativeSupervisorComposer(props: {
  readonly scope: NativeSupervisorScope | null;
  readonly config: WorkjetThreadConfig;
  readonly instanceId: string | null;
  readonly blockReason: string | null;
  readonly unavailable: boolean;
  readonly saveConfig: (config: WorkjetThreadConfig) => Promise<{ readonly _tag: string }>;
  readonly conversationTarget?: HTMLElement | null;
  readonly workerSourceControl?: ReactNode;
}) {
  const [journal, setJournal] = useState<WorkjetSupervisorJournal | null>(() =>
    props.config.schemaVersion === 2 ? (props.config.ctoxSupervisorTurn ?? null) : null,
  );
  const [routeSaving, setRouteSaving] = useState(false);
  const routeState = useSupervisorRouteDisplay(
    props.scope,
    JSON.stringify([
      journal?.turn?.commandId,
      journal?.turn?.status,
      journal?.turn?.attempt,
      routeSaving,
    ]),
  );
  const routeLabel = supervisorRouteLabel(routeState);
  const [prompt, setPrompt] = useState("");
  const [turnKind, setTurnKind] = useState<WorkjetSupervisorTurnKind>("work");
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const [capability, setCapability] = useState<ScopedSupervisorTurnCapabilities | null>(null);
  const [newMessageFor, setNewMessageFor] = useState<string | null>(null);
  const [inputFor, setInputFor] = useState<string | null>(null);
  const [inputCapability, setInputCapability] = useState<ScopedSupervisorTurnCapabilities | null>(
    null,
  );
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
  const capabilityMatches =
    props.scope !== null &&
    capability !== null &&
    capability.scope.instanceId === props.scope.instanceId &&
    capability.scope.projectId === props.scope.projectId &&
    capability.scope.threadId === props.scope.threadId;
  const conversationUnavailable =
    turnKind === "conversation" && !supervisorConversationSupported(props.scope, capability);
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
  const confirmedPending = pending && journal?.submission === "confirmed" && journal.turn !== null;
  const continuing = confirmedPending && newMessageFor === journal.intent.commandId;
  const unresolvedInput = journal?.inputs?.find((entry) => entry.receipt === null);
  const inputting = journal !== null && inputFor === journal.intent.commandId;
  const drafting = continuing || inputting;
  const inputSupported =
    scope !== null &&
    inputCapability !== null &&
    inputCapability.scope.instanceId === scope.instanceId &&
    inputCapability.scope.projectId === scope.projectId &&
    inputCapability.scope.threadId === scope.threadId &&
    !inputCapability.error &&
    inputCapability.response?.inputContract === "ctox.workjet.supervisor_input.v1" &&
    inputCapability.response.inputDelivery === "next_slice" &&
    inputCapability.response.maxInputChars === 4096;
  const previousTurns =
    props.config.schemaVersion === 2
      ? (props.config.ctoxSupervisorPreviousTurns ?? []).filter(
          (entry) =>
            scope !== null &&
            supervisorJournalMatchesScope(entry, scope) &&
            entry.intent.commandId !== journal?.intent.commandId,
        )
      : [];
  const latestProps = useRef(props);
  latestProps.current = props;

  const run = async (
    operation: "send" | "input" | "resume" | "cancel" | "events",
    pageRequest?: WorkjetSupervisorExecutionPageRequest,
  ) => {
    const current = latestProps.current;
    const target = current.scope;
    const saved = journalRef.current;
    if (
      inFlight.current ||
      (routeSaving && (operation === "send" || operation === "input")) ||
      current.unavailable ||
      target === null ||
      (saved !== null && !supervisorJournalMatchesScope(saved, target))
    )
      return;
    if (
      operation === "send" &&
      (prompt.trim() === "" ||
        conversationUnavailable ||
        (canResumeSupervisorJournal(saved, null) &&
          !(
            saved?.submission === "confirmed" &&
            saved.turn !== null &&
            newMessageFor === saved.intent.commandId
          )))
    )
      return;
    if (operation !== "send" && saved === null) return;
    if (
      operation === "input" &&
      (saved?.submission !== "confirmed" ||
        !saved.turn?.taskId ||
        !inputSupported ||
        (!unresolvedInput && (saved.turn.terminal || prompt.trim() === "")))
    )
      return;
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
          ...(turnKind === "conversation" ? { turnKind } : {}),
        };
        result = await submitWorkjetSupervisorTurn(intent, port);
      } else if (operation === "input" && saved?.turn) {
        const intent = saved.inputs?.find((entry) => entry.receipt === null)?.intent ?? {
          ...target,
          targetCommandId: saved.turn.commandId,
          commandId: CommandId.make(`owner-input-${newCommandId()}`),
          body: prompt.trim(),
          createdAt: new Date().toISOString(),
        };
        result = await submitWorkjetSupervisorInput(saved, intent, port);
        if (result._tag === "completed") {
          setNotice("Context saved for the task’s next step.");
          setPrompt((draft) => (draft === prompt ? "" : draft));
          setInputFor(null);
        }
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
            ...saved,
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
        setPrompt((draft) => (operation === "send" && draft === prompt ? "" : draft));
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
    setTurnKind("work");
    setInputFor(null);
    setNewMessageFor(null);
  }, [bindingInstanceId, bindingProjectId, bindingThreadId]);
  const bindingError = bindingMatches ? binding.error : null;
  useEffect(() => {
    if (
      disabled ||
      !bindingMatches ||
      bindingPending ||
      bindingError ||
      !bindingInstanceId ||
      !bindingProjectId ||
      !bindingThreadId
    )
      return;
    const target = {
      instanceId: bindingInstanceId,
      projectId: bindingProjectId,
      threadId: bindingThreadId,
    };
    let stale = false;
    setCapability({ scope: target, response: null, error: null });
    setInputCapability({ scope: target, response: null, error: null });
    void readWorkjetSupervisorTurnCapabilities(target, CommandId.make(`kind-${newCommandId()}`))
      .then((result) => {
        if (stale) return;
        setCapability({
          scope: target,
          response:
            result._tag === "completed" &&
            result.response.action === "project.supervisor.turn.capabilities"
              ? result.response
              : null,
          error:
            result._tag === "failed"
              ? describeWorkjetProjectControlFailure(result, target.instanceId)
              : null,
        });
      })
      .catch(() => {
        if (!stale)
          setCapability({ scope: target, response: null, error: "Could not check chat support." });
      });
    void readWorkjetSupervisorInputCapabilities(
      target,
      CommandId.make(`input-kind-${newCommandId()}`),
    )
      .then((result) => {
        if (stale) return;
        setInputCapability({
          scope: target,
          response:
            result._tag === "completed" &&
            result.response.action === "project.supervisor.turn.capabilities"
              ? result.response
              : null,
          error:
            result._tag === "failed"
              ? describeWorkjetProjectControlFailure(result, target.instanceId)
              : null,
        });
      })
      .catch(() => {
        if (!stale)
          setInputCapability({
            scope: target,
            response: null,
            error: "Could not check task context support.",
          });
      });
    return () => {
      stale = true;
    };
  }, [
    bindingInstanceId,
    bindingProjectId,
    bindingThreadId,
    disabled,
    bindingMatches,
    bindingPending,
    bindingError,
    capabilityRetry,
  ]);

  useEffect(() => {
    // Restore pending and terminal turns alike; events are backfilled from the saved identity.
    if (!restored.current && !disabled && journal !== null) {
      restored.current = true;
      if (journal.turn !== null || canResumeSupervisorJournal(journal, null))
        void runRef.current("resume");
    }
  }, [disabled, journal]);
  useEffect(() => {
    // Drafting a follow-up pauses background polling so receipt reads cannot
    // repeatedly take the Send lock. An already running read finishes normally.
    if (disabled || busy || drafting || !canResumeSupervisorJournal(journal, failureCode)) return;
    const timer = setTimeout(() => {
      void runRef.current("resume");
    }, 3000);
    return () => clearTimeout(timer);
  }, [disabled, busy, drafting, failureCode, journal]);

  useEffect(() => {
    if (disabled || busy || drafting || !execution?.page.has_more || execution.historyLimited)
      return;
    // Backfill retained pages without another turn. One request at a time; a forward native cursor is required.
    const timer = setTimeout(
      () =>
        void runRef.current("events", nextWorkjetSupervisorExecutionPageRequest(execution.page)),
      100,
    );
    return () => clearTimeout(timer);
  }, [disabled, busy, drafting, execution]);

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

  const selectTask = async (commandId: string) => {
    if (inFlight.current || disabled || (pending && !confirmedPending)) return;
    const selected = previousTurns.find((entry) => entry.intent.commandId === commandId);
    if (!selected) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await persistSupervisorJournal({
        config: latestProps.current.config,
        journal: selected,
        dispatch: latestProps.current.saveConfig,
      });
      journalRef.current = selected;
      setJournal(selected);
      setExecution(null);
      executionRef.current = null;
      setExecutionError(null);
      setError(null);
      setFailureCode(null);
      setNewMessageFor(null);
      setInputFor(null);
      restored.current = false;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not restore the task.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

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
      {previousTurns.length > 0 && journal && scopeMatches && (
        <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          Task history
          <select
            aria-label="Supervisor request"
            value={journal.intent.commandId}
            disabled={disabled || busy || (pending && !confirmedPending)}
            onChange={(event) => void selectTask(event.target.value)}
            className="min-w-0 max-w-full rounded border border-border bg-background px-2 py-1"
          >
            {[...previousTurns, journal].map((entry) => (
              <option key={entry.intent.commandId} value={entry.intent.commandId}>
                {entry.turn?.status ?? "Waiting for receipt"} · {entry.intent.goal.slice(0, 80)}
              </option>
            ))}
          </select>
        </label>
      )}
      {unresolvedInput && (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          Context receipt pending. Recover the saved message before adding another.
          <button
            type="button"
            disabled={disabled || busy || !inputSupported}
            className="ml-2 underline"
            onClick={() => void run("input")}
          >
            Recover context receipt
          </button>
        </p>
      )}
      {inputting && journal?.turn?.terminal && !unresolvedInput && (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          This task has finished. Your context was not sent.
          <button
            type="button"
            className="ml-2 underline"
            disabled={disabled || busy}
            onClick={() => setInputFor(null)}
          >
            Start a new request
          </button>
        </p>
      )}
      {confirmedPending && (
        <div
          role="status"
          className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        >
          <span>
            Previous request: {journal.turn.status}. A new message starts a separate request; this
            task stays in Task history.
          </span>
          <button
            type="button"
            disabled={disabled || !inputSupported || unresolvedInput !== undefined}
            className="underline underline-offset-2 disabled:opacity-40"
            title={
              inputSupported
                ? "Add context to this task’s next step"
                : "Task context is not supported on this connection"
            }
            onClick={() => {
              setNewMessageFor(null);
              setInputFor(journal.intent.commandId);
            }}
          >
            Add context to task
          </button>
          {!inputSupported && (
            <span>
              Same-task context is unavailable on this connection.{" "}
              <button
                type="button"
                className="underline"
                disabled={disabled || busy}
                onClick={() => setCapabilityRetry((value) => value + 1)}
              >
                Check context support
              </button>
            </span>
          )}
          {inputting && (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setInputFor(null)}
            >
              Keep waiting
            </button>
          )}
          {!continuing ? (
            <button
              type="button"
              disabled={disabled}
              className="underline underline-offset-2"
              onClick={() => {
                setInputFor(null);
                setNewMessageFor(journal.intent.commandId);
              }}
            >
              Continue anyway
            </button>
          ) : (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setNewMessageFor(null)}
            >
              Keep waiting
            </button>
          )}
        </div>
      )}
      <form
        aria-label={inputting ? "Add context to current task" : "New Supervisor request"}
        onSubmit={(event) => {
          event.preventDefault();
          if (!bindingPending) void run(inputting ? "input" : "send");
        }}
        className="flex w-full min-w-0 flex-col gap-1"
      >
        <textarea
          aria-label="Message to Supervisor"
          placeholder={
            inputting ? "Add context for this task’s next step …" : "Ask the Supervisor …"
          }
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={pending && !confirmedPending}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              shouldSubmitComposerOnEnter({
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
              })
            ) {
              event.preventDefault();
              if (!bindingPending) void run(inputting ? "input" : "send");
            }
          }}
          className="w-full min-w-0 resize-none bg-transparent px-1 py-2 text-sm outline-none"
        />
        <ComposerBar
          attachments={
            <ComposerControl
              type="button"
              disabled
              aria-label="Add attachments"
              title="This supervisor connection accepts text. Attachment support requires a CTOX update."
              className="size-7 justify-center px-0"
            >
              <PlusIcon className="size-4" />
            </ComposerControl>
          }
          worker={
            <NativeSupervisorRouteControls
              key={JSON.stringify(props.scope)}
              scope={props.scope}
              disabled={disabled || busy || inputting || pending}
              routeTitle={routeLabel.title}
              onSavingChange={setRouteSaving}
            />
          }
          status={
            <>
              <SupervisorTurnKindPicker
                scope={scope}
                capability={capability}
                value={turnKind}
                disabled={disabled || busy || inputting || (pending && !confirmedPending)}
                onChange={setTurnKind}
              />

              {props.workerSourceControl}
            </>
          }
          settings={
            <CompactComposerControlsMenu
              interactionMode="default"
              showInteractionModeToggle={false}
              onToggleInteractionMode={() => {}}
              extraMenuContent={
                <p className="max-w-64 px-2 py-1 text-xs text-muted-foreground">
                  The supervisor's context, system prompt, tools and reasoning are managed by its
                  instance.
                </p>
              }
            />
          }
          dictation={
            <ComposerDictationButton
              key={JSON.stringify(scope)}
              instanceId={props.instanceId}
              disabled={pending && !confirmedPending}
              onTranscript={(text) =>
                setPrompt((current) => (current ? `${current} ${text}` : text))
              }
            />
          }
          actions={
            <button
              type="submit"
              aria-label="Send to Supervisor"
              disabled={
                disabled ||
                routeSaving ||
                busy ||
                bindingPending ||
                (!inputting && conversationUnavailable) ||
                (inputting && !inputSupported) ||
                (inputting && journal?.turn?.terminal && !unresolvedInput) ||
                (pending && !drafting) ||
                prompt.trim() === ""
              }
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
            >
              <ArrowUpIcon className="size-4" aria-hidden="true" />
            </button>
          }
        />
      </form>
      <NativeSupervisorActualRoute state={routeState} />
      {drafting && busy && (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          Checking the task receipt. You can edit your draft; Send becomes available when this read
          finishes.
        </p>
      )}
      {capabilityMatches && capability.error && (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          Chat unavailable: {capability.error}{" "}
          <button
            type="button"
            className="underline"
            disabled={disabled || busy}
            onClick={() => setCapabilityRetry((value) => value + 1)}
          >
            Check support
          </button>
        </p>
      )}
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
