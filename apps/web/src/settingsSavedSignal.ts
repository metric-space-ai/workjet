/**
 * Autosave confirmation for simple settings values (UI rule 3, #562).
 * The settings updater reports each successful save; the row the user just
 * touched shows a short checkmark.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function notifySettingsSaved(): void {
  for (const listener of listeners) listener();
}

export function subscribeSettingsSaved(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A save counts for a row only if the user touched that row this recently. */
export const SETTINGS_SAVED_TOUCH_WINDOW_MS = 5000;
export const SETTINGS_SAVED_CHECK_MS = 1500;
