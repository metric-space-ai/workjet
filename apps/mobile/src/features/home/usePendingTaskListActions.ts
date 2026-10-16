import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Alert } from "react-native";

import { removeThreadOutboxMessage } from "../../state/thread-outbox";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { releaseEditingQueuedMessage } from "../../state/use-thread-outbox";

export function usePendingTaskListActions(): {
  readonly openPendingTask: (pendingTask: PendingNewTask) => void;
  readonly confirmDeletePendingTask: (pendingTask: PendingNewTask) => void;
} {
  const navigation = useNavigation();

  const openPendingTask = useCallback(
    (pendingTask: PendingNewTask) => {
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(pendingTask.message.environmentId),
          projectId: String(pendingTask.creation.projectId),
          pendingTaskId: String(pendingTask.message.messageId),
        },
      });
    },
    [navigation],
  );

  const confirmDeletePendingTask = useCallback((pendingTask: PendingNewTask) => {
    Alert.alert("Aufgabe löschen?", `„${pendingTask.title}“ ist noch nicht gesendet.`, [
      { text: "Abbrechen", style: "cancel" },
      {
        text: "Löschen",
        style: "destructive",
        onPress: () => {
          // Release the edit lock only after removal succeeds, and only if
          // it is held for THIS task — clearing it up front (or for another
          // task) would let the drain deliver a mid-edit payload.
          void removeThreadOutboxMessage(pendingTask.message)
            .then(() => releaseEditingQueuedMessage(pendingTask.message.messageId))
            .catch((error) => {
              Alert.alert(
                "Aufgabe nicht gelöscht",
                error instanceof Error ? error.message : "Aufgabe nicht entfernt.",
              );
            });
        },
      },
    ]);
  }, []);

  return { openPendingTask, confirmDeletePendingTask };
}
