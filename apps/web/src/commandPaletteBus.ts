// Tiny event bus for the former command palette. There is no palette dialog
// any more (drei Orte, keine Popups): the bus keeps its exported functions so
// callers compile, and `CommandPalette` (now a plain provider) maps every
// request onto an inline place:
// - no detail       → focus the sidebar search field „Suchen“;
// - "add-project"   → open the project gallery with the inline „Projekt anlegen“;
// - "new-thread-in" → start a new thread in the contextual project.
const COMMAND_PALETTE_OPEN_EVENT = "workjet:open-command-palette";
const PROJECT_CREATE_REQUEST_EVENT = "workjet:project-create-request";

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
}

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

/**
 * Kept for callers that suppress shortcuts while the palette was open. There
 * is no palette overlay any more, so this is only true for a legacy element.
 */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}

/** Selector of the sidebar search field „Suchen“ (⌘K focuses it). */
export const SIDEBAR_SEARCH_SELECTOR = "[data-sidebar-search]";

/** Focus the sidebar search field; returns false when it is not rendered. */
export function focusSidebarSearch(): boolean {
  if (typeof document === "undefined") return false;
  const input = document.querySelector<HTMLInputElement>(SIDEBAR_SEARCH_SELECTOR);
  // A collapsed sidebar keeps the field mounted but hidden; report that so
  // the caller can open the sidebar first.
  if (input === null || input.getClientRects().length === 0) return false;
  input.focus();
  input.select();
  return true;
}

// A create request can arrive before the gallery is mounted (e.g. from the
// sidebar while a thread is open). The flag survives until the gallery reads it.
let pendingProjectCreate = false;

/** Ask the project gallery to open its inline „Projekt anlegen“ panel. */
export function requestProjectCreate(): void {
  pendingProjectCreate = true;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROJECT_CREATE_REQUEST_EVENT));
}

/** Read and clear a pending create request. */
export function consumeProjectCreateRequest(): boolean {
  const pending = pendingProjectCreate;
  pendingProjectCreate = false;
  return pending;
}

export function onProjectCreateRequest(listener: () => void): () => void {
  const handler = () => {
    pendingProjectCreate = false;
    listener();
  };
  window.addEventListener(PROJECT_CREATE_REQUEST_EVENT, handler);
  return () => window.removeEventListener(PROJECT_CREATE_REQUEST_EVENT, handler);
}
