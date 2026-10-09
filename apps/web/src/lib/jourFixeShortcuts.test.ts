import { describe, expect, it } from "vite-plus/test";

import { jourFixeShortcut, type JourFixeShortcutEvent } from "./jourFixeShortcuts";

const press = (
  key: string,
  target: Partial<HTMLElement> | null = { tagName: "DIV" },
  extra: Partial<JourFixeShortcutEvent> = {},
): JourFixeShortcutEvent => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  defaultPrevented: false,
  target: target as EventTarget | null,
  ...extra,
});

describe("jourFixeShortcut", () => {
  it("maps the presenter keys", () => {
    expect(jourFixeShortcut(press("ArrowRight"), false)).toBe("next");
    expect(jourFixeShortcut(press("PageDown"), false)).toBe("next");
    expect(jourFixeShortcut(press("ArrowLeft"), false)).toBe("previous");
    expect(jourFixeShortcut(press("PageUp"), false)).toBe("previous");
    expect(jourFixeShortcut(press(" "), false)).toBe("togglePlayback");
    expect(jourFixeShortcut(press("f"), false)).toBe("toggleFullscreen");
    expect(jourFixeShortcut(press("F"), false)).toBe("toggleFullscreen");
    expect(jourFixeShortcut(press("x"), false)).toBeNull();
  });

  it("leaves keys to text fields, focused buttons and the slide editor", () => {
    expect(jourFixeShortcut(press("ArrowRight", { tagName: "INPUT" }), false)).toBeNull();
    expect(jourFixeShortcut(press("f", { tagName: "TEXTAREA" }), false)).toBeNull();
    expect(jourFixeShortcut(press(" ", { tagName: "SELECT" }), false)).toBeNull();
    expect(
      jourFixeShortcut(press("f", { tagName: "DIV", isContentEditable: true }), false),
    ).toBeNull();
    expect(jourFixeShortcut(press(" ", { tagName: "BUTTON" }), false)).toBeNull();
    expect(jourFixeShortcut(press("ArrowRight", { tagName: "BUTTON" }), false)).toBe("next");
    expect(jourFixeShortcut(press("ArrowRight"), true)).toBeNull();
  });

  it("ignores modified and already handled keys", () => {
    expect(jourFixeShortcut(press("ArrowRight", undefined, { metaKey: true }), false)).toBeNull();
    expect(jourFixeShortcut(press("f", undefined, { ctrlKey: true }), false)).toBeNull();
    expect(jourFixeShortcut(press("ArrowLeft", undefined, { altKey: true }), false)).toBeNull();
    expect(jourFixeShortcut(press(" ", undefined, { defaultPrevented: true }), false)).toBeNull();
    expect(jourFixeShortcut(press("ArrowRight", null), false)).toBe("next");
  });
});
