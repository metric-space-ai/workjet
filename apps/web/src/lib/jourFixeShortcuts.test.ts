import { describe, expect, it } from "vite-plus/test";
import { jourFixeShortcut, type JourFixeShortcutEvent } from "./jourFixeShortcuts";

function keyEvent(
  key: string,
  target: Partial<HTMLElement> | null,
  extra: Partial<JourFixeShortcutEvent> = {},
): JourFixeShortcutEvent {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    target,
    ...extra,
  };
}

const inScope = { tagName: "DIV", closest: () => ({}) as unknown as Element };
const onBody = { tagName: "BODY", closest: () => null };
const inField = { tagName: "INPUT", closest: () => ({}) as unknown as Element };

describe("jourFixeShortcut", () => {
  it("bildet die nackte Taste f nicht auf Vollbild ab", () => {
    expect(jourFixeShortcut(keyEvent("f", inScope), false)).toBeNull();
    expect(jourFixeShortcut(keyEvent("F", inScope), false)).toBeNull();
    expect(jourFixeShortcut(keyEvent("f", onBody), false)).toBeNull();
  });
  it("löst bei Fokus auf body keine Presenter-Taste aus", () => {
    expect(jourFixeShortcut(keyEvent("ArrowRight", onBody), false)).toBeNull();
    expect(jourFixeShortcut(keyEvent("ArrowLeft", onBody), false)).toBeNull();
    expect(jourFixeShortcut(keyEvent(" ", onBody), false)).toBeNull();
    expect(jourFixeShortcut(keyEvent("ArrowRight", null), false)).toBeNull();
  });
  it("wirkt mit Fokus in der Folienfläche oder auf dem Player", () => {
    expect(jourFixeShortcut(keyEvent("ArrowRight", inScope), false)).toBe("next");
    expect(jourFixeShortcut(keyEvent("ArrowLeft", inScope), false)).toBe("previous");
    expect(jourFixeShortcut(keyEvent(" ", inScope), false)).toBe("togglePlayback");
    expect(jourFixeShortcut(keyEvent("PageDown", inScope), false)).toBe("next");
  });
  it("lässt Eingabefelder, Buttons und den Folien-Editor unangetastet", () => {
    expect(jourFixeShortcut(keyEvent("ArrowRight", inField), false)).toBeNull();
    expect(
      jourFixeShortcut(
        keyEvent(" ", { tagName: "BUTTON", closest: () => ({}) as unknown as Element }),
        false,
      ),
    ).toBeNull();
    expect(jourFixeShortcut(keyEvent("ArrowRight", inScope), true)).toBeNull();
    expect(jourFixeShortcut(keyEvent("ArrowRight", inScope, { metaKey: true }), false)).toBeNull();
  });
});
