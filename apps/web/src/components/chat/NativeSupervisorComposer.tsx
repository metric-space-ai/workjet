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
import { OptionSelect } from "../ui/option-select";
import {
  cloneElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ComponentProps,
} from "react";
import { ArrowUpIcon, PlusIcon } from "lucide-react";
import { ComposerBar } from "./ComposerBar";
import { ComposerDictationButton } from "./ComposerDictationButton";
import { ComposerControl } from "./ComposerControl";
import { shouldSubmitComposerOnEnter } from "../../composer-logic";
import { createPortal } from "react-dom";
import { useProjectOverviewLanguage } from "../../hooks/useProjectOverviewLanguage";
import { SecretRequestCards } from "./SecretRequestCard";
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

import {
  NativeSupervisorRouteControls,
  type SupervisorRouteStatus,
} from "./NativeSupervisorRouteControls";
import { NativeSupervisorActualRoute } from "./NativeSupervisorActualRoute";
import { useSupervisorRouteDisplay } from "./useSupervisorRouteDisplay";
import { WorkerSourceConnectionPicker } from "./WorkerSourceConnectionPicker";
import { ComposerErrorLine } from "./ComposerErrorLine";
import {
  COMPOSER_AUTHENTICATION_LINE,
  COMPOSER_RECONNECT_LABEL,
  classifyComposerError,
  composerErrorLine,
  composerRawErrorText,
  type ComposerErrorLine as ComposerErrorLineValue,
} from "./composerErrorLineLogic";
import { useComposerSilentRetry } from "./useComposerSilentRetry";
import { usePrimaryEnvironment } from "../../state/environments";
import { workerSourceProvisionRequest } from "../../workjetWorkerSourceConnection";
import type {
  NativeWorkerSourceControl,
  WorkerSourceConnectionStatus,
} from "./NativeWorkerSourceControl";

export function NativeSupervisorComposer(props: {
  readonly scope: NativeSupervisorScope | null;
  readonly config: WorkjetThreadConfig;
  readonly instanceId: string | null;
  readonly blockReason: string | null;
  readonly unavailable: boolean;
  readonly saveConfig: (config: WorkjetThreadConfig) => Promise<{ readonly _tag: string }>;
  readonly conversationTarget?: HTMLElement | null;
  readonly workerSourceControl?: ReactElement<ComponentProps<typeof NativeWorkerSourceControl>>;
}) {
  const secretLanguage = useProjectOverviewLanguage();
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
  const [routeStatus, setRouteStatus] = useState<SupervisorRouteStatus | null>(null);
  const environment = usePrimaryEnvironment();
  const [workerStatus, setWorkerStatus] = useState<WorkerSourceConnectionStatus | null>(null);
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
        // Optimistisch senden: die Nachricht steht sofort im Verlauf, die
        // Leiste bleibt frei. Ein endgültiger Fehlschlag steht an der Nachricht.
        setPrompt((draft) => (draft === prompt ? "" : draft));
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
          setNotice("Kontext gespeichert");
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
          setNotice("Abbruch angefordert");
        } else if (result._tag === "completed")
          throw new Error("The response belongs to a different task.");
      }
      if (journalRef.current?.turn?.terminal) setNotice(null);
      if (result?._tag === "failed") {
        setFailureCode(result.code);
        // Laden und Wiederholen laufen still; nur der ausdrückliche Abbruch
        // meldet sich, weil der Nutzer ihn gerade angefordert hat.
        if (operation === "cancel")
          setError(describeWorkjetProjectControlFailure(result, target.instanceId));
      }
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
              appended.conflicted ? "Verlauf widersprüchlich, bitte neu laden" : null,
            );
          } else if (observed._tag === "failed") {
            setExecutionError(
              observed.code === "unsupported"
                ? "Kein Ausführungsverlauf in dieser CTOX-Version"
                : "Ausführungsverlauf nicht verfügbar",
            );
          }
        } catch {
          setExecutionError("Verlauf nicht gespeichert");
        }
      }
    } catch (failure) {
      setFailureCode("local_failed");
      setError(failure instanceof Error ? failure.message : "CTOX-Aufgabe nicht bestätigt");
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
            error: "Supervisor nicht verbunden",
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
  // Verbindungsabbrüche und langsame Antworten werden still erneut versucht;
  // die Leiste zeigt dafür keine Fehlerzeile mehr.
  const connectionError = failureCode === "authentication_required" ? error : null;
  const authenticationRequired = Boolean(
    props.instanceId?.startsWith("managed:") &&
    ((bindingMatches && binding.authenticationRequired) ||
      failureCode === "authentication_required" ||
      journal?.submissionError === "authentication_required" ||
      workerStatus?.authenticationRequired === true ||
      props.blockReason?.startsWith("Sign in to ctox.dev") ||
      props.blockReason?.startsWith("Bei ctox.dev anmelden")),
  );
  // Genau eine Zeile über dem Eingabefeld; Rohtext nur hinter „Details“.
  const retryProjectConnection = () => {
    refreshWorkjetProjectRegistry(latestProps.current.instanceId);
    requestLocalProjectRegistrationRetry();
    setBindingRetry((value) => value + 1);
  };
  const composerIssue: {
    readonly error: unknown;
    readonly fallback: string;
    readonly retry: (() => void) | null;
  } | null = authenticationRequired
    ? null
    : disabled && !workerStatus?.choice
      ? {
          error:
            props.blockReason ?? (props.instanceId ? "Projektverbindung nicht verfügbar" : null),
          fallback: "Projektverbindung nicht verfügbar",
          retry: props.instanceId !== null ? retryProjectConnection : null,
        }
      : workerStatus && !workerStatus.choice
        ? {
            error: workerStatus.message,
            fallback: "Presets nicht verbunden",
            retry: workerStatus.retry,
          }
        : error && !connectionError
          ? {
              error,
              fallback: "Anfrage nicht gesendet",
              retry: journal !== null ? () => void runRef.current("resume") : null,
            }
          : routeStatus;
  const composerIssueUnreachable =
    composerIssue !== null &&
    composerRawErrorText(composerIssue.error) !== null &&
    classifyComposerError(composerIssue.error) === "unreachable";
  const unreachableForMs = useComposerSilentRetry(
    composerIssueUnreachable,
    composerIssue?.retry ?? null,
  );
  const composerLine: ComposerErrorLineValue | null = authenticationRequired
    ? {
        kind: "authentication",
        text: COMPOSER_AUTHENTICATION_LINE,
        action: "reconnect",
        actionLabel: COMPOSER_RECONNECT_LABEL,
        details:
          composerRawErrorText(
            props.blockReason?.startsWith("Sign in to ctox.dev") ||
              props.blockReason?.startsWith("Bei ctox.dev anmelden")
              ? props.blockReason
              : (connectionError ?? bindingError),
          ) ?? null,
      }
    : workerStatus?.choice
      ? {
          kind: "failed",
          text: workerStatus.message,
          action: "retry",
          actionLabel: "",
          details: null,
        }
      : composerIssue === null
        ? null
        : composerErrorLine(composerIssue.error, {
            fallback: composerIssue.fallback,
            unreachableForMs,
          });
  // Binding- und Capability-Prüfungen wiederholen sich still, bis sie klappen.
  useEffect(() => {
    if (disabled || !bindingMatches || bindingPending || bindingError === null) return;
    const timer = setTimeout(() => setBindingRetry((value) => value + 1), 8000);
    return () => clearTimeout(timer);
  }, [disabled, bindingMatches, bindingPending, bindingError]);
  useEffect(() => {
    if (!capabilityMatches || capability?.error == null) return;
    const timer = setTimeout(() => setCapabilityRetry((value) => value + 1), 8000);
    return () => clearTimeout(timer);
  }, [capabilityMatches, capability?.error]);
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
          setCapability({ scope: target, response: null, error: "Chat-Prüfung fehlgeschlagen" });
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
            error: "Kontextprüfung fehlgeschlagen",
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

  // Derselbe Erneuerungsweg wie die Presets-Seite: Zugang neu ausstellen; nur ein
  // abgemeldetes Konto führt zuerst durch die ctox.dev-Anmeldung.
  const reconnectInstance = async () => {
    const bridge = window.desktopBridge?.ctox;
    if (!bridge || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const request =
        environment === null
          ? null
          : workerSourceProvisionRequest(environment.environmentId, latestProps.current.instanceId);
      const provision = bridge.provisionDecisionHub;
      let result = request && provision ? await provision(request) : null;
      if (result === null || (result._tag === "failed" && result.code === "signed_out")) {
        const login = await bridge.login();
        if (login._tag === "completed" && request && provision) result = await provision(request);
      }
      refreshWorkjetProjectRegistry(latestProps.current.instanceId);
      requestLocalProjectRegistrationRetry();
      setError(null);
      setFailureCode(null);
      setBindingRetry((value) => value + 1);
      workerStatus?.retry?.();
    } catch {
      // Still: die Zeile bleibt mit derselben Aktion stehen.
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

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
      setError(failure instanceof Error ? failure.message : "Aufgabe nicht wiederhergestellt");
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
        onRetrySend={() => void run("resume")}
      />
    ) : null;

  return (
    <section className="mx-auto w-full max-w-5xl p-3" aria-label="Supervisor-Aufgabe">
      <SecretRequestCards
        instanceId={props.instanceId}
        threadKey={props.scope?.threadId ?? null}
        language={secretLanguage}
      />
      {props.conversationTarget && conversation
        ? createPortal(conversation, props.conversationTarget)
        : null}
      {journal && scopeMatches && !props.conversationTarget && (
        <div className="mb-3 max-h-52 overflow-y-auto text-sm" aria-live="polite">
          <p className="whitespace-pre-wrap break-words">{journal.intent.goal}</p>
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
            <p className="text-xs text-muted-foreground">Ergebnis gekürzt</p>
          )}
          {journal.submission === "not-submitted" && !pending && (
            <p role="status" className="text-muted-foreground">
              Nicht gesendet
              {" · "}
              <button
                type="button"
                className="underline underline-offset-2"
                disabled={disabled || busy}
                onClick={() => void run("resume")}
              >
                Erneut senden
              </button>
            </p>
          )}
          {journal.turn?.errorMessage &&
            (() => {
              const failed = composerErrorLine(journal.turn.errorMessage, {
                fallback: "Aufgabe fehlgeschlagen",
                unreachableForMs: Number.POSITIVE_INFINITY,
              });
              return failed ? <ComposerErrorLine line={failed} onAction={null} /> : null;
            })()}
        </div>
      )}
      {props.workerSourceControl &&
        cloneElement(props.workerSourceControl, {
          headless: true,
          onStatusChange: setWorkerStatus,
        })}
      {notice && (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {composerLine && (
        <ComposerErrorLine
          line={composerLine}
          disabled={
            authenticationRequired
              ? busy
              : workerStatus?.retry && composerIssue?.retry === workerStatus.retry
                ? workerStatus.disabled
                : busy || bindingPending
          }
          busyLabel={authenticationRequired && busy ? "Verbindet …" : null}
          control={
            workerStatus?.choice && !authenticationRequired ? (
              <WorkerSourceConnectionPicker
                choice={workerStatus.choice}
                disabled={workerStatus.disabled}
              />
            ) : undefined
          }
          onAction={
            authenticationRequired ? () => void reconnectInstance() : (composerIssue?.retry ?? null)
          }
        />
      )}
      {previousTurns.length > 0 && journal && scopeMatches && (
        <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          Verlauf
          <OptionSelect
            aria-label="Supervisor-Anfrage"
            className="w-auto min-w-0 max-w-full"
            value={journal.intent.commandId}
            disabled={disabled || busy || (pending && !confirmedPending)}
            options={[...previousTurns, journal].map((entry) => ({
              value: entry.intent.commandId,
              label: `${entry.turn?.status ?? "Warte auf Bestätigung"} · ${entry.intent.goal.slice(0, 80)}`,
            }))}
            onValueChange={(commandId) => void selectTask(commandId)}
          />
        </label>
      )}
      {unresolvedInput && (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          Kontext unbestätigt
          <button
            type="button"
            disabled={disabled || busy || !inputSupported}
            className="ml-2 underline"
            onClick={() => void run("input")}
          >
            Bestätigung abrufen
          </button>
        </p>
      )}
      {inputting && journal?.turn?.terminal && !unresolvedInput && (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          Aufgabe beendet, Kontext nicht gesendet
          <button
            type="button"
            className="ml-2 underline"
            disabled={disabled || busy}
            onClick={() => setInputFor(null)}
          >
            Neue Anfrage
          </button>
        </p>
      )}
      {confirmedPending && (
        <div
          role="status"
          className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        >
          <span>Vorherige Anfrage: {journal.turn.status}</span>
          <button
            type="button"
            disabled={disabled || !inputSupported || unresolvedInput !== undefined}
            className="underline underline-offset-2 disabled:opacity-40"
            title={inputSupported ? "Kontext ergänzen" : "Nicht unterstützt"}
            onClick={() => {
              setNewMessageFor(null);
              setInputFor(journal.intent.commandId);
            }}
          >
            Kontext ergänzen
          </button>
          {!inputSupported && (
            <span>
              Kein Aufgabenkontext{" "}
              <button
                type="button"
                className="underline"
                disabled={disabled || busy}
                onClick={() => setCapabilityRetry((value) => value + 1)}
              >
                Erneut prüfen
              </button>
            </span>
          )}
          {inputting && (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setInputFor(null)}
            >
              Weiter warten
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
              Trotzdem fortfahren
            </button>
          ) : (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setNewMessageFor(null)}
            >
              Weiter warten
            </button>
          )}
        </div>
      )}
      <form
        aria-label={inputting ? "Kontext ergänzen" : "Neue Supervisor-Anfrage"}
        onSubmit={(event) => {
          event.preventDefault();
          if (!bindingPending) void run(inputting ? "input" : "send");
        }}
        className="flex w-full min-w-0 flex-col gap-1"
      >
        <textarea
          aria-label="Nachricht an Supervisor"
          placeholder={inputting ? "Kontext ergänzen …" : "Supervisor fragen …"}
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
              aria-label="Anhänge hinzufügen"
              title="Anhänge nicht unterstützt"
              className="size-7 justify-center px-0"
            >
              <PlusIcon className="size-4" />
            </ComposerControl>
          }
          worker={
            <NativeSupervisorRouteControls
              key={JSON.stringify(props.scope)}
              scope={props.scope}
              workerSourceBinding={
                props.config.schemaVersion === 2
                  ? props.config.capabilityBindings.find(
                      (binding) => binding.capabilityId === "ctox-business-os",
                    )?.target
                  : undefined
              }
              disabled={busy || inputting || routeSaving}
              onSavingChange={setRouteSaving}
              onStatusChange={setRouteStatus}
            />
          }
          settings={
            <SupervisorTurnKindPicker
              scope={scope}
              capability={capability}
              value={turnKind}
              disabled={disabled || busy || inputting || (pending && !confirmedPending)}
              onChange={setTurnKind}
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
              aria-label="An Supervisor senden"
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
      {journal && (
        <div className="mt-2 flex gap-3 text-xs">
          {pending && journal.turn && (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => {
                void run("cancel");
              }}
            >
              Abbrechen
            </button>
          )}
        </div>
      )}
    </section>
  );
}
