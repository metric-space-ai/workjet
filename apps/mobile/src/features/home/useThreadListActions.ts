import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/shell";
import { canSettle, canSnooze } from "@workjet/client-runtime/state/thread-settled";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import {
  pinOrderKeyBetween,
  planPinnedMove,
  sortPinnedThreadsByOrderKey,
} from "@workjet/client-runtime/state/thread-sort";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { userFacingErrorText } from "../../lib/userFacingError";

/** Version skew: never send settle/unsettle to a server that predates them
    (capability defaults false on decode for older servers). */
function environmentSupportsSettlement(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

function environmentSupportsSnooze(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSnooze === true
  );
}

function environmentSupportsPinning(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinning === true
  );
}

function environmentSupportsPinReorder(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinReorder === true
  );
}

function environmentSupportsTitleRegeneration(
  environmentId: EnvironmentThreadShell["environmentId"],
) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadTitleRegeneration === true
  );
}

type ThreadListAction = "archive" | "unarchive" | "delete" | "settle" | "unsettle";

function selectionHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function actionFailureTitle(action: ThreadListAction): string {
  if (action === "archive") return "Nicht archiviert";
  if (action === "unarchive") return "Nicht wiederhergestellt";
  if (action === "settle") return "Nicht erledigt";
  if (action === "unsettle") return "Nicht wieder geöffnet";
  return "Nicht gelöscht";
}

/** Resolves to true iff the action was dispatched and succeeded. */
function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const inFlightThreadKeys = useRef(new Set<string>());

  const executeAction = useCallback(
    async (action: ThreadListAction, thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (inFlightThreadKeys.current.has(key)) {
        return false;
      }

      inFlightThreadKeys.current.add(key);
      selectionHaptic();
      try {
        if (
          (action === "settle" || action === "unsettle") &&
          !environmentSupportsSettlement(thread.environmentId)
        ) {
          Alert.alert(actionFailureTitle(action), "Rechner aktualisieren, um zu erledigen.");
          return false;
        }
        // Settle may only target what effectiveSettled could classify as
        // settled: not starting/running sessions, not threads waiting on
        // approvals or user input. Anything else would hide live work.
        if (action === "settle" && !canSettle(thread, { now: new Date().toISOString() })) {
          Alert.alert(actionFailureTitle(action), "Braucht Aufmerksamkeit. Erst klären.");
          return false;
        }
        // Archive keeps its original, narrower guard: never interrupt a
        // thread mid-turn.
        if (
          action === "archive" &&
          thread.session?.status === "running" &&
          thread.session.activeTurnId != null
        ) {
          Alert.alert(actionFailureTitle(action), "Arbeitet noch. Erst unterbrechen.");
          return false;
        }
        const result =
          action === "unsettle"
            ? // reason "user" pins the thread active: auto-settle stays
              // suppressed until real activity clears the pin server-side.
              await unsettleMutation({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, reason: "user" },
              })
            : await (
                action === "settle"
                  ? settleMutation
                  : action === "archive"
                    ? archiveMutation
                    : action === "unarchive"
                      ? unarchiveMutation
                      : deleteMutation
              )({
                environmentId: thread.environmentId,
                input: { threadId: thread.id },
              });
        if (result._tag === "Failure") {
          Alert.alert(
            actionFailureTitle(action),
            userFacingErrorText(Cause.squash(result.cause), "useThreadListActions"),
          );
          return false;
        }
        // Settled threads stay in the live shell stream; only the archive
        // lifecycle still feeds the archived-snapshot surface.
        if (action === "archive" || action === "unarchive" || action === "delete") {
          refreshArchivedThreadsForEnvironment(thread.environmentId);
        }
        onCompleted?.(action, thread);
        return true;
      } finally {
        inFlightThreadKeys.current.delete(key);
      }
    },
    [
      archiveMutation,
      deleteMutation,
      onCompleted,
      settleMutation,
      unarchiveMutation,
      unsettleMutation,
    ],
  );

  return executeAction;
}

function useConfirmDeleteThread(
  executeAction: (action: ThreadListAction, thread: EnvironmentThreadShell) => Promise<boolean>,
) {
  return useCallback(
    (thread: EnvironmentThreadShell) => {
      const title = "Unterhaltung löschen?";
      const message = `„${thread.title}“ wird endgültig gelöscht.`;
      if (process.env.EXPO_OS === "ios") {
        Alert.alert(title, message, [
          { text: "Abbrechen", style: "cancel" },
          {
            text: "Löschen",
            style: "destructive",
            onPress: () => {
              void executeAction("delete", thread);
            },
          },
        ]);
        return;
      }
      showConfirmDialog({
        title,
        message,
        confirmText: "Delete",
        destructive: true,
        onConfirm: () => {
          void executeAction("delete", thread);
        },
      });
    },
    [executeAction],
  );
}

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly settleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly snoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => Promise<boolean>;
  readonly unsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly pinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly movePinnedThread: (
    thread: EnvironmentThreadShell,
    direction: "up" | "down",
  ) => Promise<boolean>;
  readonly regenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
} {
  const executeAction = useThreadActionExecutor();
  const snoozeMutation = useAtomCommand(threadEnvironment.snooze, { reportFailure: false });
  const unsnoozeMutation = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const pinMutation = useAtomCommand(threadEnvironment.pin, { reportFailure: false });
  const unpinMutation = useAtomCommand(threadEnvironment.unpin, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const snoozeInFlightThreadKeys = useRef(new Set<string>());
  const titleRegenerationInFlightThreadKeys = useRef(new Set<string>());

  const archiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("archive", thread);
    },
    [executeAction],
  );
  const settleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction("settle", thread)) === true,
    [executeAction],
  );
  const snoozeThread = useCallback(
    async (thread: EnvironmentThreadShell, snoozedUntil: string) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (snoozeInFlightThreadKeys.current.has(key)) {
        return false;
      }
      snoozeInFlightThreadKeys.current.add(key);
      try {
        if (!environmentSupportsSnooze(thread.environmentId)) {
          Alert.alert("Nicht zurückgestellt", "Rechner aktualisieren, um zurückzustellen.");
          return false;
        }
        if (!canSnooze(thread, { now: new Date().toISOString() })) {
          Alert.alert(
            "Nicht zurückgestellt",
            thread.hasPendingApprovals || thread.hasPendingUserInput
              ? "Wartet auf dich. Erst antworten."
              : "Startet noch. Gleich erneut versuchen.",
          );
          return false;
        }

        selectionHaptic();
        const result = await snoozeMutation({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            snoozedUntil,
          },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Alert.alert("Nicht zurückgestellt", userFacingErrorText(error, "useThreadListActions"));
          return false;
        }
        return true;
      } finally {
        snoozeInFlightThreadKeys.current.delete(key);
      }
    },
    [snoozeMutation],
  );
  const unsnoozeThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (snoozeInFlightThreadKeys.current.has(key)) {
        return false;
      }
      snoozeInFlightThreadKeys.current.add(key);
      try {
        if (!environmentSupportsSnooze(thread.environmentId)) {
          Alert.alert("Nicht geweckt", "Rechner aktualisieren, um zu wecken.");
          return false;
        }

        selectionHaptic();
        const result = await unsnoozeMutation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, reason: "user" },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Alert.alert("Nicht geweckt", userFacingErrorText(error, "useThreadListActions"));
          return false;
        }
        return true;
      } finally {
        snoozeInFlightThreadKeys.current.delete(key);
      }
    },
    [unsnoozeMutation],
  );
  const unsettleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction("unsettle", thread)) === true,
    [executeAction],
  );
  const pinThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      if (!environmentSupportsPinning(thread.environmentId)) {
        Alert.alert("Nicht angeheftet", "Rechner aktualisieren, um anzuheften.");
        return false;
      }
      selectionHaptic();
      // Same placement as web: a fresh pin takes the top of the arranged
      // run. Servers that predate reordering get the bare pin (keyless).
      let orderKey: string | undefined;
      if (environmentSupportsPinReorder(thread.environmentId)) {
        const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
        let firstKey: string | null = null;
        for (const shell of shells) {
          if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
          if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
        }
        orderKey = pinOrderKeyBetween(null, firstKey) ?? undefined;
      }
      const result = await pinMutation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, ...(orderKey !== undefined ? { orderKey } : {}) },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Alert.alert("Nicht angeheftet", userFacingErrorText(error, "useThreadListActions"));
        return false;
      }
      return true;
    },
    [pinMutation],
  );
  const unpinThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      if (!environmentSupportsPinning(thread.environmentId)) {
        Alert.alert("Nicht gelöst", "Rechner aktualisieren, um anzuheften.");
        return false;
      }
      selectionHaptic();
      const result = await unpinMutation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Alert.alert("Nicht gelöst", userFacingErrorText(error, "useThreadListActions"));
        return false;
      }
      return true;
    },
    [unpinMutation],
  );
  const regenerateThreadTitle = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (
        thread.titleRegeneration != null ||
        titleRegenerationInFlightThreadKeys.current.has(key)
      ) {
        return false;
      }
      if (!environmentSupportsTitleRegeneration(thread.environmentId)) {
        Alert.alert("Titel nicht neu erzeugt", "Rechner aktualisieren, um Titel neu zu erzeugen.");
        return false;
      }

      titleRegenerationInFlightThreadKeys.current.add(key);
      selectionHaptic();
      try {
        const result = await updateThreadMetadata({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, regenerateTitle: true },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Alert.alert(
            "Titel nicht neu erzeugt",
            userFacingErrorText(error, "useThreadListActions"),
          );
          return false;
        }
        return true;
      } finally {
        titleRegenerationInFlightThreadKeys.current.delete(key);
      }
    },
    [updateThreadMetadata],
  );

  // Move up / Move down for the pinned block. Computed against the CANONICAL
  // keyed pinned order (not the rendered list), so the move is valid even
  // while search or a project scope filters rows: the same fractional-key
  // scheme web dragging uses, one write to one thread per move (plus a
  // one-time section materialization when legacy keyless pins are involved).
  const reorderPinnedMutation = useAtomCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  // One move at a time: a second tap before the first write's event lands
  // would plan from the same stale snapshot and silently collapse two moves
  // into one — same double-dispatch guard as snoozeThread.
  const movePinnedInFlightRef = useRef(false);
  const movePinnedThread = useCallback(
    async (thread: EnvironmentThreadShell, direction: "up" | "down") => {
      if (movePinnedInFlightRef.current) return false;
      if (!environmentSupportsPinReorder(thread.environmentId)) {
        Alert.alert("Nicht verschoben", "Rechner aktualisieren, um zu sortieren.");
        return false;
      }
      const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
      const pinned = sortPinnedThreadsByOrderKey(
        shells.filter(
          (shell) =>
            shell.pinnedAt != null &&
            shell.archivedAt === null &&
            environmentSupportsPinReorder(shell.environmentId),
        ),
      );
      const orderedIds = pinned.map((shell) => scopedThreadKey(shell.environmentId, shell.id));
      const assignments = planPinnedMove({
        orderedIds,
        keysById: new Map(
          pinned.map((shell) => [
            scopedThreadKey(shell.environmentId, shell.id),
            shell.pinOrderKey ?? null,
          ]),
        ),
        movedId: scopedThreadKey(thread.environmentId, thread.id),
        direction,
      });
      if (assignments === null || assignments.length === 0) return false;
      const shellByKey = new Map(
        pinned.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell]),
      );
      selectionHaptic();
      movePinnedInFlightRef.current = true;
      try {
        for (const assignment of assignments) {
          const target = shellByKey.get(assignment.id);
          if (target === undefined) continue;
          const result = await reorderPinnedMutation({
            environmentId: target.environmentId,
            input: { threadId: target.id, orderKey: assignment.orderKey },
          });
          if (result._tag === "Failure") {
            const error = Cause.squash(result.cause);
            Alert.alert("Nicht verschoben", userFacingErrorText(error, "useThreadListActions"));
            // No rollback: keys already written are valid orderings on their
            // own (each write is a complete, consistent placement), so a
            // partial materialization leaves the list sensible, not corrupt.
            return false;
          }
        }
        return true;
      } finally {
        movePinnedInFlightRef.current = false;
      }
    },
    [reorderPinnedMutation],
  );

  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    movePinnedThread,
    regenerateThreadTitle,
  };
}

export function useArchivedThreadListActions(
  onCompleted: (thread: EnvironmentThreadShell) => void,
): {
  readonly unarchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const handleCompleted = useCallback(
    (_action: ThreadListAction, thread: EnvironmentThreadShell) => {
      onCompleted(thread);
    },
    [onCompleted],
  );
  const executeAction = useThreadActionExecutor(handleCompleted);
  const unarchiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("unarchive", thread);
    },
    [executeAction],
  );
  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return { unarchiveThread, confirmDeleteThread };
}
