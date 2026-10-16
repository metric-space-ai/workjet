import { scopeProjectRef, scopedThreadKey } from "@workjet/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
} from "@workjet/client-runtime/state/runtime";
import {
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestStateLike,
} from "@workjet/client-runtime/state/thread-settled";
import type { ScopedThreadRef, ThreadId } from "@workjet/contracts";
import { useCallback } from "react";

import { resolveSnoozePresets, snoozeWakeDescription } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { scheduleUndoableThreadDelete } from "../lib/undoableDelete";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsTitleRegeneration,
  readThreadShell,
} from "../state/entities";
import { readLocalApi } from "../localApi";
import { useUiStateStore } from "../uiStateStore";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { useThreadActions } from "./useThreadActions";

function failureToast(title: string) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
    }),
  );
}

/**
 * The per-thread action menu (pin, settle, snooze, rename, copy, delete…) as
 * a self-contained hook, for surfaces other than the sidebar row — today the
 * chat header. Renders through the native context-menu bridge and dispatches
 * through the same mutations the sidebar uses.
 *
 * Unlike the sidebar, settle and snooze here never navigate away: the caller
 * is acting on the thread they are reading, and ChatView's parked-thread
 * banner already offers the way back.
 */
export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** Fallback for "Copy path" when the thread has no worktree. */
  readonly projectCwd: string | null;
  /** PR state feeding auto-settle classification, as resolved by the caller. */
  readonly changeRequestState: ChangeRequestStateLike | null;
  readonly onStartRename: () => void;
}) {
  const { threadRef, projectCwd, changeRequestState, onStartRename } = input;
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
  const autoSettleOnMerge = useClientSettings((s) => s.sidebarAutoSettleOnMerge);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: () => {
      toastManager.add({ type: "success", title: "Pfad kopiert" });
    },
    onError: () => failureToast("Kopieren fehlgeschlagen"),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: () => {
      toastManager.add({ type: "success", title: "Branch kopiert" });
    },
    onError: () => failureToast("Kopieren fehlgeschlagen"),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: () => {
      toastManager.add({ type: "success", title: "ID kopiert" });
    },
    onError: () => failureToast("Kopieren fehlgeschlagen"),
  });

  const openMenu = useCallback(
    (position: { x: number; y: number }) => {
      if (threadRef === null) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        // Snapshot at open time — the menu is modal, so state read now is
        // what the user is looking at.
        const thread = readThreadShell(threadRef);
        if (!thread) return;
        const now = new Date();
        const supports = {
          settlement: readEnvironmentSupportsSettlement(threadRef.environmentId),
          snooze: readEnvironmentSupportsSnooze(threadRef.environmentId),
          pinning: readEnvironmentSupportsPinning(threadRef.environmentId),
          titleRegeneration: readEnvironmentSupportsTitleRegeneration(threadRef.environmentId),
        };
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const snoozePresets = resolveSnoozePresets(now, timestampFormat);
        const items = buildThreadActionMenuItems({
          branch: thread.branch ?? null,
          isPinned: thread.pinnedAt != null,
          isSettled:
            supports.settlement &&
            effectiveSettled(thread, {
              // Minute-quantized like useNowMinute, so this classification
              // can never disagree with the sidebar partition or ChatView's
              // parked-thread banner within the same minute.
              now: `${now.toISOString().slice(0, 16)}:00.000Z`,
              autoSettleAfterDays,
              autoSettleOnMerge,
              changeRequestState,
            }),
          isSnoozed: supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() }),
          canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
          isRegeneratingTitle,
          supports,
          snoozePresets,
        });
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const action: ThreadActionMenuId = clicked.value;
        if (action.startsWith("snooze:")) {
          const preset = snoozePresets.find((candidate) => `snooze:${candidate.id}` === action);
          if (!preset) return;
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) {
              failureToast("Zurückstellen fehlgeschlagen");
            }
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Zurückgestellt bis ${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat)}`,
              timeout: 5_000,
              actionProps: {
                children: "Rückgängig",
                onClick: () => {
                  void unsnoozeThread(threadRef).then((undone) => {
                    if (undone._tag === "Failure" && !isAtomCommandInterrupted(undone)) {
                      failureToast("Aufwecken fehlgeschlagen");
                    }
                  });
                },
              },
            }),
          );
          return;
        }
        const reportFailure = async (
          title: string,
          run: () => Promise<AtomCommandResult<unknown, unknown>>,
        ) => {
          const result = await run();
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(title);
          }
        };
        switch (action) {
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              failureToast("Unterhaltung nicht erstellt");
            }
            return;
          }
          case "settle":
            await reportFailure("Abschließen fehlgeschlagen", () => settleThread(threadRef));
            return;
          case "unsettle":
            await reportFailure("Wiederöffnen fehlgeschlagen", () => unsettleThread(threadRef));
            return;
          case "unsnooze":
            await reportFailure("Aufwecken fehlgeschlagen", () => unsnoozeThread(threadRef));
            return;
          case "pin":
            await reportFailure("Anheften fehlgeschlagen", () => pinThread(threadRef));
            return;
          case "unpin":
            await reportFailure("Lösen fehlgeschlagen", () => unpinThread(threadRef));
            return;
          case "rename":
            onStartRename();
            return;
          case "regenerate-title":
            if (isRegeneratingTitle) return;
            await reportFailure("Titel nicht erzeugt", () =>
              updateThreadMetadata({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, regenerateTitle: true },
              }),
            );
            return;
          case "mark-unread":
            markThreadUnread(scopedThreadKey(threadRef), thread.latestTurn?.completedAt);
            return;
          case "copy-path": {
            const workspacePath = thread.worktreePath ?? projectCwd;
            if (!workspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Kein Pfad vorhanden",
                }),
              );
              return;
            }
            copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          }
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "delete": {
            // Undo instead of confirm (#637).
            scheduleUndoableThreadDelete(1, async () => {
              const deleted = await deleteThread(threadRef);
              if (
                deleted._tag === "Failure" &&
                !isAtomCommandInterrupted(deleted) &&
                // A failure with the thread already gone is worktree cleanup
                // failing after a successful delete — deleteThread has toasted
                // that itself, and "Failed to delete thread" would be a lie.
                readThreadShell(threadRef) !== null
              ) {
                failureToast("Löschen fehlgeschlagen");
              }
            });
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      autoSettleAfterDays,
      autoSettleOnMerge,
      changeRequestState,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleNewThread,
      markThreadUnread,
      onStartRename,
      pinThread,
      projectCwd,
      settleThread,
      snoozeThread,
      threadRef,
      timestampFormat,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
      updateThreadMetadata,
    ],
  );

  return { openMenu };
}
