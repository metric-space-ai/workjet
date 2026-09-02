import type {
  CtoxWorkjetSessionControlRequest,
  CtoxWorkjetSessionTransferNotification,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { toastManager } from "../components/ui/toast";
import { newCommandId } from "../lib/utils";
import { useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { acknowledgeWorkjetSessionPause } from "../workjetSessionControl";
import {
  planPauseReaction,
  runPauseHardCancel,
  type WorkjetSessionPausePlan,
} from "../workjetSessionPauseObserver";
import { usePrimarySettings } from "./useSettings";

export const WORKJET_SESSION_PAUSE_WAIT_MAX_MS = 40_000;
export const WORKJET_SESSION_STOP_CONFIRM_MAX_MS = 15_000;
export const WORKJET_SESSION_STOP_UNCONFIRMED_TOAST =
  "Übergabe wartet: Worker-Prozess konnte nicht sicher beendet werden";
const WORKJET_SESSION_PAUSE_POLL_MS = 250;
const acknowledgedTransferIds = new Set<string>();
const processingTransferIds = new Set<string>();
const stopRequestedTransferIds = new Set<string>();

export function pauseWaitTimeoutMs(deadlineAtMs: number, nowMs: number): number {
  return Math.max(0, Math.min(WORKJET_SESSION_PAUSE_WAIT_MAX_MS, deadlineAtMs - nowMs));
}

function configuredInstanceId(thread: { readonly workjetConfig: object }): string | null {
  const config = thread.workjetConfig;
  if (!("ctoxSession" in config)) return null;
  const session = config.ctoxSession;
  if (typeof session !== "object" || session === null || !("instanceId" in session)) return null;
  return typeof session.instanceId === "string" ? session.instanceId : null;
}

function sameThread(
  thread: { readonly environmentId: string; readonly id: string },
  ref: ScopedThreadRef,
): boolean {
  return thread.environmentId === ref.environmentId && thread.id === ref.threadId;
}

export function buildPauseAcknowledgementRequest(input: {
  readonly notification: CtoxWorkjetSessionTransferNotification;
  readonly localComputerId: string;
  readonly lastTerminalTurnId: string | null;
  readonly gitRepository: boolean;
}): Extract<CtoxWorkjetSessionControlRequest, { readonly action: "session.transfer.pause_ack" }> {
  return {
    action: "session.transfer.pause_ack",
    commandId: newCommandId(),
    transferId: input.notification.event.transferId,
    computerId: input.localComputerId,
    fenceEpoch: input.notification.event.fenceEpoch,
    lastTerminalTurnId: input.lastTerminalTurnId,
    gitRepository: input.gitRepository,
    idempotencyKey: newCommandId(),
  };
}

export function useWorkjetSessionPauseObserver(): void {
  const threads = useThreadShells();
  const computers = usePrimarySettings((settings) => settings.workjet.computers);
  const localComputerId =
    computers.find((computer) => computer.presentationKind === "local")?.id ?? null;
  const computerIds = useMemo(() => computers.map((computer) => computer.id), [computers]);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const threadsRef = useRef(threads);
  const localComputerIdRef = useRef<string | null>(localComputerId);
  const activeWaitsRef = useRef(new Map<string, AbortController>());
  threadsRef.current = threads;
  localComputerIdRef.current = localComputerId;

  const plan = useCallback(
    (notification: CtoxWorkjetSessionTransferNotification): WorkjetSessionPausePlan =>
      planPauseReaction({
        event: notification.event,
        threads: threadsRef.current,
        localComputerId: localComputerIdRef.current,
        acknowledged: acknowledgedTransferIds,
      }),
    [],
  );

  const acknowledge = useCallback(
    async (
      notification: CtoxWorkjetSessionTransferNotification,
      reaction: Extract<WorkjetSessionPausePlan, { readonly kind: "ack" }>,
    ): Promise<void> => {
      const transferId = notification.event.transferId;
      if (acknowledgedTransferIds.has(transferId)) return;
      const localId = localComputerIdRef.current;
      const thread = threadsRef.current.find((candidate) =>
        sameThread(candidate, reaction.threadRef),
      );
      if (
        localId === null ||
        thread === undefined ||
        configuredInstanceId(thread) !== notification.instanceId
      ) {
        return;
      }

      acknowledgedTransferIds.add(transferId);
      const result = await acknowledgeWorkjetSessionPause(
        notification.instanceId,
        buildPauseAcknowledgementRequest({
          notification,
          localComputerId: localId,
          lastTerminalTurnId: reaction.lastTerminalTurnId,
          gitRepository: thread.branch !== null,
        }),
      );
      if (
        result._tag !== "completed" ||
        result.response.action !== "session.transfer.pause_ack" ||
        !result.response.outcome.ok
      ) {
        console.warn("Workjet session pause acknowledgement was not accepted", {
          transferId,
          result,
        });
      }
    },
    [],
  );

  const waitForStillness = useCallback(
    async (
      notification: CtoxWorkjetSessionTransferNotification,
      threadRef: ScopedThreadRef,
    ): Promise<void> => {
      const transferId = notification.event.transferId;
      const controller = new AbortController();
      activeWaitsRef.current.set(transferId, controller);
      const nowMs = Date.now();
      const expiresAt = nowMs + pauseWaitTimeoutMs(notification.event.deadlineAtMs, nowMs);

      try {
        while (!controller.signal.aborted) {
          const reaction = plan(notification);
          if (reaction.kind === "ack") {
            const thread = threadsRef.current.find((candidate) =>
              sameThread(candidate, reaction.threadRef),
            );
            if (thread !== undefined && configuredInstanceId(thread) === notification.instanceId) {
              await acknowledge(notification, reaction);
              return;
            }
          }
          const remainingMs = expiresAt - Date.now();
          if (remainingMs <= 0) break;
          await new Promise<void>((resolve) => {
            const timeout = window.setTimeout(
              resolve,
              Math.min(WORKJET_SESSION_PAUSE_POLL_MS, remainingMs),
            );
            controller.signal.addEventListener(
              "abort",
              () => {
                window.clearTimeout(timeout);
                resolve();
              },
              { once: true },
            );
          });
        }

        if (!controller.signal.aborted) {
          await runPauseHardCancel({
            transferId,
            threadRef,
            requestedTransferIds: stopRequestedTransferIds,
            requestStop: () =>
              stopSession({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId },
              }),
            readThread: () =>
              threadsRef.current.find(
                (candidate) =>
                  sameThread(candidate, threadRef) &&
                  configuredInstanceId(candidate) === notification.instanceId,
              ),
            acknowledge: (lastTerminalTurnId) =>
              acknowledge(notification, {
                kind: "ack",
                threadRef,
                lastTerminalTurnId,
              }),
            onUnconfirmed: () => {
              console.warn(
                `Workjet session stop could not be confirmed for thread ${threadRef.threadId}`,
                { transferId },
              );
              toastManager.add({
                type: "warning",
                title: WORKJET_SESSION_STOP_UNCONFIRMED_TOAST,
              });
            },
            isCancelled: () => controller.signal.aborted,
            timeoutMs: WORKJET_SESSION_STOP_CONFIRM_MAX_MS,
            pollMs: WORKJET_SESSION_PAUSE_POLL_MS,
          });
        }
      } finally {
        activeWaitsRef.current.delete(transferId);
        processingTransferIds.delete(transferId);
      }
    },
    [acknowledge, plan, stopSession],
  );

  const observe = useCallback(
    (notification: CtoxWorkjetSessionTransferNotification): void => {
      const transferId = notification.event.transferId;
      if (processingTransferIds.has(transferId) || acknowledgedTransferIds.has(transferId)) return;
      const reaction = plan(notification);
      if (reaction.kind === "ignore") return;
      const thread = threadsRef.current.find((candidate) =>
        sameThread(candidate, reaction.threadRef),
      );
      if (thread === undefined || configuredInstanceId(thread) !== notification.instanceId) return;
      if (reaction.kind === "ack") {
        processingTransferIds.add(transferId);
        void acknowledge(notification, reaction).finally(() => {
          processingTransferIds.delete(transferId);
        });
        return;
      }

      processingTransferIds.add(transferId);
      void interruptTurn({
        environmentId: reaction.threadRef.environmentId,
        input: {
          threadId: reaction.threadRef.threadId,
          ...(thread.session?.status === "running" && thread.session.activeTurnId !== null
            ? { turnId: thread.session.activeTurnId }
            : {}),
        },
      });
      void waitForStillness(notification, reaction.threadRef);
    },
    [acknowledge, interruptTurn, plan, waitForStillness],
  );

  useEffect(() => {
    const bridge = window.desktopBridge?.ctox;
    if (bridge?.registerSessionTransferEvents === undefined) return;
    void bridge.registerSessionTransferEvents(computerIds);
  }, [computerIds]);

  useEffect(() => {
    const subscribe = window.desktopBridge?.ctox?.onSessionTransferEvent;
    if (subscribe === undefined) return;
    return subscribe(observe);
  }, [observe]);

  useEffect(
    () => () => {
      for (const controller of activeWaitsRef.current.values()) controller.abort();
      activeWaitsRef.current.clear();
    },
    [],
  );
}
