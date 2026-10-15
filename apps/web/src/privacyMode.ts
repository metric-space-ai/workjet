/**
 * Privacy mode (#526): blurs project names, websites, KPI and exit values in
 * overviews, lists, sidebar, calendar, search, tooltips and toasts so screen
 * sharing and screenshots leak nothing. The open project's detail view stays
 * readable. One persisted flag per device, toggled from the title bar or with
 * Cmd/Ctrl+Shift+B. Nothing is revealed on hover.
 */
import { useSyncExternalStore } from "react";

export const PRIVACY_MODE_STORAGE_KEY = "workjet.privacyMode";
export const PRIVACY_MODE_ATTRIBUTE = "data-privacy-mode";
export const PRIVACY_TITLE_STASH = "data-privacy-title";

/** Everything that is blurred while privacy mode is on. Mirrored in index.css. */
export const PRIVACY_SENSITIVE_SELECTORS = [
  "[data-sensitive]",
  "[data-workjet-project-card]",
  "[data-thread-item]",
  '[data-testid="sidebar-draft-row"]',
  '[data-workjet-action^="project.open.calendar"]',
  '[data-slot="command-item"]',
  '[data-slot="tooltip-popup"]',
  '[data-slot="toast-title"]',
  '[data-slot="toast-description"]',
] as const;

/** Containers whose content stays readable: the open project's detail view. */
export const PRIVACY_REVEAL_SELECTORS = [
  '[data-privacy-scope="reveal"]',
  "[data-workjet-project-overview]",
] as const;

const SENSITIVE = PRIVACY_SENSITIVE_SELECTORS.join(",");
const REVEAL = PRIVACY_REVEAL_SELECTORS.join(",");

const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return globalThis.localStorage?.getItem(PRIVACY_MODE_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

let enabled = readStored();

export function isPrivacyModeEnabled(): boolean {
  return enabled;
}

export function setPrivacyMode(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    globalThis.localStorage?.setItem(PRIVACY_MODE_STORAGE_KEY, next ? "on" : "off");
  } catch {
    // Blocked storage: the mode still applies for this session.
  }
  applyPrivacyMode();
  for (const listener of listeners) listener();
}

export function togglePrivacyMode(): void {
  setPrivacyMode(!enabled);
}

export function usePrivacyMode(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isPrivacyModeEnabled,
    () => false,
  );
}

/** Cmd+Shift+B on macOS, Ctrl+Shift+B elsewhere. */
export function isPrivacyModeShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
  mac: boolean,
): boolean {
  const key = event.code === "KeyB" || event.key.toLowerCase() === "b";
  const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return key && modifier && event.shiftKey && !event.altKey;
}

export function privacyModeLabels(language: "de" | "en") {
  return language === "en"
    ? { enable: "Turn on privacy mode", disable: "Turn off privacy mode" }
    : { enable: "Privacy-Modus einschalten", disable: "Privacy-Modus ausschalten" };
}

/** True when the element sits in a blurred area outside every reveal scope. */
export function isPrivacySensitive(element: Element): boolean {
  return element.closest(SENSITIVE) !== null && element.closest(REVEAL) === null;
}

/** Native `title` tooltips would show the text unblurred: stash them while on. */
export function neutralizeTitles(root: ParentNode, on: boolean): void {
  if (on) {
    for (const element of root.querySelectorAll("[title]")) {
      if (!isPrivacySensitive(element)) continue;
      element.setAttribute(PRIVACY_TITLE_STASH, element.getAttribute("title") ?? "");
      element.removeAttribute("title");
    }
    return;
  }
  for (const element of root.querySelectorAll(`[${PRIVACY_TITLE_STASH}]`)) {
    element.setAttribute("title", element.getAttribute(PRIVACY_TITLE_STASH) ?? "");
    element.removeAttribute(PRIVACY_TITLE_STASH);
  }
}

let observer: MutationObserver | null = null;

function applyPrivacyMode(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (enabled) root.setAttribute(PRIVACY_MODE_ATTRIBUTE, "on");
  else root.removeAttribute(PRIVACY_MODE_ATTRIBUTE);
  neutralizeTitles(document, enabled);
  if (enabled && observer === null && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => neutralizeTitles(document, true));
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title"],
    });
  } else if (!enabled && observer !== null) {
    observer.disconnect();
    observer = null;
  }
}

/** Mount once at the app root: applies the stored mode and the shortcut. */
export function installPrivacyMode(mac: boolean): () => void {
  applyPrivacyMode();
  const onKey = (event: KeyboardEvent) => {
    if (!isPrivacyModeShortcut(event, mac)) return;
    event.preventDefault();
    togglePrivacyMode();
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
