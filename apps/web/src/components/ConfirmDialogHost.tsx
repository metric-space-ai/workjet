import { useEffect, useSyncExternalStore } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  respondToConfirmDialog,
  subscribeConfirmDialog,
} from "../confirmDialog";
import { InlineConfirmBar, InlineNoticePortal } from "./InlineNoticeSlot";

export interface ConfirmationCopy {
  /** Eine Zeile: die Frage. Erklärsätze der Aufrufer entfallen (UI-Vertrag §2). */
  readonly question: string;
  /** Beschriftung der Primäraktion, aus der Frage abgeleitet. */
  readonly confirmLabel: string;
}

const DEFAULT_CONFIRM_LABEL = "Bestätigen";

/**
 * Die Aufrufer übergeben noch englische Fragen. Bis sie deutsch formulieren
 * (Übergabe an ihre Besitzer), übersetzt diese Tabelle die bekannten Fragen
 * und leitet die Primäraktion ab. Unbekannte Fragen bleiben unverändert.
 */
const QUESTION_TRANSLATIONS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly question: (match: RegExpMatchArray) => string;
  readonly confirmLabel: string;
}> = [
  {
    pattern: /^Delete thread "(.+)"\?$/,
    question: (m) => `Thread „${m[1]}“ löschen?`,
    confirmLabel: "Löschen",
  },
  {
    pattern: /^Delete (\d+) threads?\?$/,
    question: (m) => (m[1] === "1" ? "1 Thread löschen?" : `${m[1]} Threads löschen?`),
    confirmLabel: "Löschen",
  },
  {
    pattern: /^Archive (\d+) threads?\?$/,
    question: (m) => (m[1] === "1" ? "1 Thread archivieren?" : `${m[1]} Threads archivieren?`),
    confirmLabel: "Archivieren",
  },
  {
    pattern: /^Remove project "(.+)" and delete its (\d+) threads?\?$/,
    question: (m) =>
      m[2] === "1"
        ? `Projekt „${m[1]}“ und 1 Thread löschen?`
        : `Projekt „${m[1]}“ und ${m[2]} Threads löschen?`,
    confirmLabel: "Löschen",
  },
  {
    pattern: /^Remove project "(.+)"\?$/,
    question: (m) => `Projekt „${m[1]}“ entfernen?`,
    confirmLabel: "Entfernen",
  },
  {
    pattern: /^Delete the worktree too\?$/,
    question: () => "Worktree auch löschen?",
    confirmLabel: "Löschen",
  },
  {
    pattern: /^Revert this thread to checkpoint (\d+)\?$/,
    question: (m) => `Thread auf Checkpoint ${m[1]} zurücksetzen?`,
    confirmLabel: "Zurücksetzen",
  },
  {
    pattern: /^Restore default settings\?$/,
    question: () => "Standardeinstellungen wiederherstellen?",
    confirmLabel: "Wiederherstellen",
  },
  {
    pattern: /^Send SIGKILL to process (\d+)\?$/,
    question: (m) => `SIGKILL an Prozess ${m[1]} senden?`,
    confirmLabel: "Senden",
  },
  {
    pattern: /^Install update(?: (\S+))? and restart Workjet\?$/,
    question: (m) =>
      m[1]
        ? `Update ${m[1]} installieren und neu starten?`
        : "Update installieren und neu starten?",
    confirmLabel: "Installieren",
  },
  {
    pattern: /^Turn on token-by-token output\?$/,
    question: () => "Token-für-Token-Ausgabe einschalten?",
    confirmLabel: "Einschalten",
  },
];

/** Die Frage einer Nachricht: die erste Zeile, die mit „?“ endet, sonst der erste Satz. */
function extractQuestion(message: string): string {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n").map((line) => line.trim());
  const questionLine = lines.find((line) => line.endsWith("?"));
  if (questionLine) return questionLine;

  const questionMarkIndex = normalizedMessage.indexOf("?");
  if (questionMarkIndex >= 0) {
    return normalizedMessage.slice(0, questionMarkIndex + 1).trim();
  }

  return lines.find((line) => line.length > 0) ?? "";
}

export function resolveConfirmDialogCopy(message: string, confirmLabel?: string): ConfirmationCopy {
  const question = extractQuestion(message);
  for (const translation of QUESTION_TRANSLATIONS) {
    const match = question.match(translation.pattern);
    if (match) {
      return {
        question: translation.question(match),
        confirmLabel: confirmLabel ?? translation.confirmLabel,
      };
    }
  }
  return {
    question: question || "Fortfahren?",
    confirmLabel: confirmLabel ?? DEFAULT_CONFIRM_LABEL,
  };
}

/**
 * Bestätigungen ohne Modal: eine Zeile direkt unter dem Kopf,
 * „Frage · [Bestätigen] [Abbrechen]“, Esc bricht ab. Die API
 * `confirmDialog()`/`localApi.dialogs.confirm()` bleibt unverändert
 * (Promise<boolean>), alle Aufrufer laufen ohne Anpassung weiter.
 */
export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialog,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  useEffect(() => registerConfirmDialogHost(), []);

  // Ohne Ausblend-Animation gibt es nichts abzuwarten: die nächste Frage aus
  // der Warteschlange folgt sofort.
  useEffect(() => {
    if (state.status === "closing") completeConfirmDialogClose();
  }, [state]);

  if (state.status !== "confirming") return null;

  const copy = resolveConfirmDialogCopy(state.message, state.confirmLabel);

  return (
    <InlineNoticePortal>
      <InlineConfirmBar
        key={state.message}
        confirmLabel={copy.confirmLabel}
        markers={{
          row: "confirm-bar",
          confirm: "confirm-bar-confirm",
          cancel: "confirm-bar-cancel",
        }}
        question={copy.question}
        variant={state.variant}
        onCancel={() => respondToConfirmDialog(false)}
        onConfirm={() => respondToConfirmDialog(true)}
      />
    </InlineNoticePortal>
  );
}
