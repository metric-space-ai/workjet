import { workjetUiLanguage } from "./workjetProjectControl";

/**
 * The one status vocabulary (UI rule 7, #566): ok | läuft | wartet |
 * blockiert (Grund) | fehlt. Card, Rechner, Modelle and Instanz all map their
 * own enums onto it, so the same state has the same word and the same color.
 */
export type WorkjetStatus = "ok" | "running" | "waiting" | "blocked" | "missing";

export const WORKJET_STATUS_DOT_CLASS: Readonly<Record<WorkjetStatus, string>> = {
  ok: "bg-success",
  running: "bg-primary",
  waiting: "bg-warning",
  blocked: "bg-destructive",
  missing: "bg-muted-foreground/40",
};

export const WORKJET_STATUS_TEXT_CLASS: Readonly<Record<WorkjetStatus, string>> = {
  ok: "text-success",
  running: "text-primary",
  waiting: "text-warning",
  blocked: "text-destructive",
  missing: "text-muted-foreground",
};

/** Thread pill labels (Sidebar.logic / ThreadStatusIndicators). */
export function workjetStatusFromThreadPill(label: string): WorkjetStatus {
  switch (label) {
    case "Freigabe offen":
    case "Wartet auf Eingabe":
    case "Plan bereit":
      return "waiting";
    case "Arbeitet":
    case "Verbindet":
    case "Beobachtet":
      return "running";
    case "Fertig":
      return "ok";
    default:
      return "missing";
  }
}

const WORDS: Readonly<Record<"de" | "en", Readonly<Record<WorkjetStatus, string>>>> = {
  de: { ok: "ok", running: "läuft", waiting: "wartet", blocked: "blockiert", missing: "fehlt" },
  en: { ok: "ok", running: "running", waiting: "waiting", blocked: "blocked", missing: "missing" },
};

/** Status word, with the reason appended for "blocked" (e.g. "blockiert (Anmeldung)"). */
export function workjetStatusWord(
  status: WorkjetStatus,
  reason?: string | null,
  language: "de" | "en" = workjetUiLanguage(),
): string {
  const word = WORDS[language][status];
  return status === "blocked" && reason ? `${word} (${reason})` : word;
}

/** Client connection phases (ConnectionStatusDot). */
export function workjetStatusFromConnectionPhase(phase: string): WorkjetStatus {
  switch (phase) {
    case "connected":
      return "ok";
    case "connecting":
    case "reconnecting":
      return "waiting";
    case "error":
      return "blocked";
    default:
      return "missing";
  }
}

/** Server provider status keys (providerStatus.ts). */
export function workjetStatusFromProvider(
  key: "ready" | "warning" | "error" | "disabled",
): WorkjetStatus {
  switch (key) {
    case "ready":
      return "ok";
    case "warning":
      return "waiting";
    case "error":
      return "blocked";
    case "disabled":
      return "missing";
  }
}

/** Gateway account health (WorkjetModelsHealth.ts). */
export function workjetStatusFromModelsHealth(
  status: "ready" | "disabled" | "auth-required" | "cooldown" | "unavailable" | "unknown",
): WorkjetStatus {
  switch (status) {
    case "ready":
      return "ok";
    case "cooldown":
      return "waiting";
    case "auth-required":
    case "unavailable":
      return "blocked";
    case "disabled":
    case "unknown":
      return "missing";
  }
}
