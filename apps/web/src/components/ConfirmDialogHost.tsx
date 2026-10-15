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
 * Die Aufrufer übergeben deutsche Fragen. Die Primäraktion wird aus dem
 * Verb der Frage abgeleitet; unbekannte Verben bestätigen mit „Bestätigen“.
 */
const CONFIRM_VERBS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly confirmLabel: string;
}> = [
  { pattern: /\binstallieren\b/u, confirmLabel: "Installieren" },
  { pattern: /\blöschen\?$/u, confirmLabel: "Löschen" },
  { pattern: /\barchivieren\?$/u, confirmLabel: "Archivieren" },
  { pattern: /\bentfernen\?$/u, confirmLabel: "Entfernen" },
  { pattern: /\bzurücksetzen\?$/u, confirmLabel: "Zurücksetzen" },
  { pattern: /\bwiederherstellen\?$/u, confirmLabel: "Wiederherstellen" },
  { pattern: /\bsenden\?$/u, confirmLabel: "Senden" },
  { pattern: /\beinschalten\?$/u, confirmLabel: "Einschalten" },
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
  const derived = CONFIRM_VERBS.find((verb) => verb.pattern.test(question))?.confirmLabel;
  return {
    question: question || "Fortfahren?",
    confirmLabel: confirmLabel ?? derived ?? DEFAULT_CONFIRM_LABEL,
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
