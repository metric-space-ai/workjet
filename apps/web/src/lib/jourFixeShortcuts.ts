/** Presenter keys in the meeting room, as in learnordie's live presenter. */
export type JourFixeShortcut = "previous" | "next" | "togglePlayback";

export interface JourFixeShortcutEvent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Folienfläche, Player und Vorschauleiste bilden den Presenter-Bereich. Tasten
 * wirken nur, wenn der Fokus in diesem Bereich liegt – nie, wenn er auf `body`
 * gefallen ist oder in einem Eingabefeld steht.
 */
export const JOUR_FIXE_PRESENTER_SCOPE = "[data-workjet-presenter-scope]";

/**
 * The presenter action for a key press, or null when the key belongs to something else: a
 * text field, a focused control, the slide editor, a shortcut with a modifier, or a focus
 * outside the presenter area. Full screen has no single-letter key; it is the button only.
 */
export function jourFixeShortcut(
  event: JourFixeShortcutEvent,
  editingSlide: boolean,
): JourFixeShortcut | null {
  if (editingSlide || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
    return null;
  }
  const target = event.target as Partial<HTMLElement> | null;
  const tag = typeof target?.tagName === "string" ? target.tagName.toUpperCase() : "";
  if (TYPING_TAGS.has(tag) || target?.isContentEditable === true) return null;
  // A focused button already answers Space and Enter itself.
  if (event.key === " " && tag === "BUTTON") return null;
  const inScope =
    typeof target?.closest === "function" && target.closest(JOUR_FIXE_PRESENTER_SCOPE) !== null;
  if (!inScope) return null;
  switch (event.key) {
    case "ArrowRight":
    case "PageDown":
      return "next";
    case "ArrowLeft":
    case "PageUp":
      return "previous";
    case " ":
      return "togglePlayback";
    default:
      return null;
  }
}
