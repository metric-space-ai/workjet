import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  consumeProjectCreateRequest,
  focusSidebarSearch,
  isCommandPaletteOpen,
  onNewThreadMenuRequest,
  onOpenCommandPalette,
  onProjectCreateRequest,
  onSidebarSearchMode,
  openCommandPalette,
  requestNewThreadMenu,
  requestProjectCreate,
  requestSidebarSearchMode,
  sidebarSearchModeForCommand,
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

describe("sidebar search modes and the new-thread dropdown", () => {
  it("maps ⌘K, ⌘P and ⌘⇧F onto one inline search field", () => {
    expect(sidebarSearchModeForCommand("commandPalette.toggle")).toBe("threads");
    expect(sidebarSearchModeForCommand("filePicker.toggle")).toBe("files");
    expect(sidebarSearchModeForCommand("projectSearch.toggle")).toBe("content");
    expect(sidebarSearchModeForCommand("chat.new")).toBeNull();
    expect(sidebarSearchModeForCommand(null)).toBeNull();
  });

  it("delivers the requested search mode to the sidebar", () => {
    const seen: string[] = [];
    const stop = onSidebarSearchMode((mode) => seen.push(mode));
    requestSidebarSearchMode("files");
    requestSidebarSearchMode("content");
    stop();
    requestSidebarSearchMode("threads");
    expect(seen).toEqual(["files", "content"]);
  });

  it("opens the dropdown only when a sidebar listens, else reports the fallback", () => {
    expect(requestNewThreadMenu()).toBe(false);
    let opened = 0;
    const stop = onNewThreadMenuRequest(() => {
      opened += 1;
    });
    expect(requestNewThreadMenu()).toBe(true);
    stop();
    expect(requestNewThreadMenu()).toBe(false);
    expect(opened).toBe(1);
  });
});
