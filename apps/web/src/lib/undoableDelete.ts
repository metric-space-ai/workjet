import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { workjetUiLanguage } from "../workjetProjectControl";

/** How long a delete can be undone before it really runs. */
export const UNDO_DELETE_MS = 6_000;

/**
 * Undo instead of confirm (#637): the delete runs after a short grace period
 * unless the toast's „Rückgängig“ is pressed. No modal question.
 */
export function scheduleUndoableDelete(input: {
  readonly title: string;
  readonly undoLabel: string;
  readonly run: () => void | Promise<void>;
  readonly delayMs?: number;
  /** Called when „Rückgängig“ is pressed, e.g. to show a hidden row again. */
  readonly onUndo?: () => void;
}): () => void {
  let cancelled = false;
  const timer = setTimeout(() => {
    if (!cancelled) void input.run();
  }, input.delayMs ?? UNDO_DELETE_MS);
  const cancel = () => {
    cancelled = true;
    clearTimeout(timer);
  };
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: input.title,
      timeout: input.delayMs ?? UNDO_DELETE_MS,
      actionProps: {
        children: input.undoLabel,
        onClick: () => {
          cancel();
          input.onUndo?.();
        },
      },
    }),
  );
  return cancel;
}

/** „N Unterhaltungen gelöscht“ / „N chats deleted“ with the shared undo label. */
export function scheduleUndoableThreadDelete(
  count: number,
  run: () => void | Promise<void>,
): () => void {
  const en = workjetUiLanguage() === "en";
  const title = en
    ? count === 1
      ? "Chat deleted"
      : `${count} chats deleted`
    : count === 1
      ? "Unterhaltung gelöscht"
      : `${count} Unterhaltungen gelöscht`;
  return scheduleUndoableDelete({ title, undoLabel: en ? "Undo" : "Rückgängig", run });
}
