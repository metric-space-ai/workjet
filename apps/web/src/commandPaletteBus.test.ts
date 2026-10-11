import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  consumeProjectCreateRequest,
  focusSidebarSearch,
  isCommandPaletteOpen,
  onOpenCommandPalette,
  onProjectCreateRequest,
  openCommandPalette,
  requestProjectCreate,
} from "./commandPaletteBus";

// The bus only needs an EventTarget-shaped window and a querySelector.
beforeEach(() => {
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal(
    "CustomEvent",
    class extends Event {
      readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        super(type);
        this.detail = init?.detail;
      }
    },
  );
  consumeProjectCreateRequest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("command palette bus without a palette dialog", () => {
  it("delivers open requests with their detail to the provider", () => {
    const seen: unknown[] = [];
    const stop = onOpenCommandPalette((detail) => seen.push(detail));
    openCommandPalette({ open: "add-project" });
    openCommandPalette({ open: "new-thread-in" });
    openCommandPalette();
    stop();
    openCommandPalette({ open: "add-project" });
    expect(seen).toEqual([{ open: "add-project" }, { open: "new-thread-in" }, {}]);
  });

  it("keeps a project create request until the gallery reads it", () => {
    requestProjectCreate();
    expect(consumeProjectCreateRequest()).toBe(true);
    expect(consumeProjectCreateRequest()).toBe(false);
  });

  it("hands a create request to a mounted gallery and clears the pending flag", () => {
    let opened = 0;
    const stop = onProjectCreateRequest(() => {
      opened += 1;
    });
    requestProjectCreate();
    stop();
    expect(opened).toBe(1);
    expect(consumeProjectCreateRequest()).toBe(false);
  });

  it("never reports an open palette and focuses only a visible search field", () => {
    expect(isCommandPaletteOpen()).toBe(false);
    expect(focusSidebarSearch()).toBe(false);
    const focus = vi.fn();
    const select = vi.fn();
    vi.stubGlobal("document", {
      querySelector: () => ({ focus, select, getClientRects: () => [{}] }),
    });
    expect(focusSidebarSearch()).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    vi.stubGlobal("document", {
      querySelector: () => ({ focus, select, getClientRects: () => [] }),
    });
    expect(focusSidebarSearch()).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
  });
});
