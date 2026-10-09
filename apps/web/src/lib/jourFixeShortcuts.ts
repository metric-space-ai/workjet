/** Presenter keys in the meeting room, as in learnordie's live presenter. */
export type JourFixeShortcut = "previous" | "next" | "togglePlayback" | "toggleFullscreen";

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
 * The presenter action for a key press, or null when the key belongs to something else: a
 * text field, a focused control, the slide editor, or a shortcut with a modifier.
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
  switch (event.key) {
    case "ArrowRight":
    case "PageDown":
      return "next";
    case "ArrowLeft":
    case "PageUp":
      return "previous";
    case " ":
      return "togglePlayback";
    case "f":
    case "F":
      return "toggleFullscreen";
    default:
      return null;
  }
}
