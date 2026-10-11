import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { resolveConfirmDialogCopy } from "./ConfirmDialogHost";
import { ensureInlineNoticeSlot, InlineConfirmBar } from "./InlineNoticeSlot";

describe("inline confirmation copy", () => {
  it.each([
    ["Unterhaltung „Fix login“ löschen?", "Unterhaltung „Fix login“ löschen?", "Löschen"],
    ["3 Unterhaltungen löschen?", "3 Unterhaltungen löschen?", "Löschen"],
    ["1 Unterhaltung löschen?", "1 Unterhaltung löschen?", "Löschen"],
    [
      "Projekt „workjet“ und 4 Unterhaltungen löschen?\nPfad: /repo",
      "Projekt „workjet“ und 4 Unterhaltungen löschen?",
      "Löschen",
    ],
    ["2 Unterhaltungen archivieren?", "2 Unterhaltungen archivieren?", "Archivieren"],
    ["Projekt „workjet“ entfernen?\nPfad: /repo", "Projekt „workjet“ entfernen?", "Entfernen"],
    ["Worktree ebenfalls löschen?\n/tmp/wt", "Worktree ebenfalls löschen?", "Löschen"],
    [
      "Unterhaltung auf Checkpoint 3 zurücksetzen?\nNeuere Nachrichten und Diffs gehen verloren.",
      "Unterhaltung auf Checkpoint 3 zurücksetzen?",
      "Zurücksetzen",
    ],
    [
      "Standard wiederherstellen?\nZurückgesetzt wird: Theme.",
      "Standard wiederherstellen?",
      "Wiederherstellen",
    ],
    ["SIGKILL an Prozess 4711 senden?", "SIGKILL an Prozess 4711 senden?", "Senden"],
    [
      "Update 0.0.86 installieren und Workjet neu starten?\n\nLaufende Aufgaben werden unterbrochen.",
      "Update 0.0.86 installieren und Workjet neu starten?",
      "Installieren",
    ],
    ["Token-für-Token-Ausgabe einschalten?", "Token-für-Token-Ausgabe einschalten?", "Einschalten"],
  ])("shows only the question for %j and derives the action", (message, question, confirmLabel) => {
    expect(resolveConfirmDialogCopy(message)).toEqual({ question, confirmLabel });
  });

  it("keeps an unknown question as one line and confirms with „Bestätigen“", () => {
    expect(resolveConfirmDialogCopy("Weiter?\nZweite Zeile.")).toEqual({
      question: "Weiter?",
      confirmLabel: "Bestätigen",
    });
    expect(resolveConfirmDialogCopy("Proceed with the reset\nsecond line")).toEqual({
      question: "Proceed with the reset",
      confirmLabel: "Bestätigen",
    });
    expect(resolveConfirmDialogCopy("")).toEqual({
      question: "Fortfahren?",
      confirmLabel: "Bestätigen",
    });
  });

  it("lets a caller choose the confirm label", () => {
    expect(resolveConfirmDialogCopy("2 Unterhaltungen löschen?", "Weg damit")).toEqual({
      question: "2 Unterhaltungen löschen?",
      confirmLabel: "Weg damit",
    });
  });
});

describe("InlineConfirmBar", () => {
  it("renders one non-modal line: question, confirm, cancel", () => {
    const markup = renderToStaticMarkup(
      <InlineConfirmBar
        markers={{
          row: "confirm-bar",
          confirm: "confirm-bar-confirm",
          cancel: "confirm-bar-cancel",
        }}
        question="Unterhaltung „Fix login“ löschen?"
        confirmLabel="Löschen"
        variant="destructive"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(markup).toContain("data-confirm-bar");
    expect(markup).toContain('role="group"');
    expect(markup).toContain("Unterhaltung „Fix login“ löschen?");
    expect(markup).toMatch(/data-confirm-bar-confirm[^>]*>Löschen</);
    expect(markup).toMatch(/data-confirm-bar-cancel[^>]*>Abbrechen</);
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('role="alertdialog"');
    expect(markup).not.toContain("aria-modal");
  });
});

describe("inline notice slot", () => {
  function fakeDocument(withContent: boolean, withSlot = false) {
    const inserted: Array<{ node: FakeElement; before: FakeElement }> = [];
    class FakeElement {
      readonly attributes = new Map<string, string>();
      className = "";
      parentElement: FakeElement | null = null;
      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      }
      insertBefore(node: FakeElement, before: FakeElement) {
        node.parentElement = this;
        inserted.push({ node, before });
        return node;
      }
    }
    const parent = new FakeElement();
    const content = new FakeElement();
    content.parentElement = parent;
    const slot = new FakeElement();
    const doc = {
      querySelector(selector: string) {
        if (selector === "[data-workjet-inline-notices]") {
          if (withSlot) return slot;
          return inserted[0]?.node ?? null;
        }
        if (selector === "[data-workjet-content]") return withContent ? content : null;
        return null;
      },
      createElement() {
        return new FakeElement();
      },
    };
    return { doc: doc as unknown as Document, inserted, content, slot };
  }

  it("inserts one slot between header and content and reuses it", () => {
    const { doc, inserted, content } = fakeDocument(true);
    const first = ensureInlineNoticeSlot(doc) as unknown as {
      attributes: Map<string, string>;
    } | null;
    expect(first).not.toBeNull();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.before).toBe(content);
    expect(first?.attributes.has("data-workjet-inline-notices")).toBe(true);
    expect(ensureInlineNoticeSlot(doc)).toBe(first);
    expect(inserted).toHaveLength(1);
  });

  it("prefers a slot the layout provides and waits while there is no layout", () => {
    const provided = fakeDocument(true, true);
    expect(ensureInlineNoticeSlot(provided.doc)).toBe(provided.slot);
    expect(provided.inserted).toHaveLength(0);

    const empty = fakeDocument(false);
    expect(ensureInlineNoticeSlot(empty.doc)).toBeNull();
  });
});
