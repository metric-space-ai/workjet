// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it, vi } from "vite-plus/test";

const exposeInMainWorld = vi.fn();
const send = vi.fn();
const on = vi.fn();

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { send, on },
}));

await import("./CtoxGuestPreload.ts");

describe("CtoxGuestPreload", () => {
  it("exposes only the fixed no-argument managed refresh event", () => {
    expect(exposeInMainWorld).toHaveBeenCalledOnce();
    const [name, bridge] = exposeInMainWorld.mock.calls[0] as [string, Record<string, () => void>];
    expect(name).toBe("ctoxBusinessOsDesktop");
    expect(Object.keys(bridge)).toEqual(["refreshManagedLaunch"]);

    bridge.refreshManagedLaunch?.();

    expect(send).toHaveBeenCalledWith("instance:refresh-managed-launch");
    expect(send.mock.calls[0]).toHaveLength(1);
  });

  it("applies only allowlisted, bounded host theme tokens", () => {
    const properties = new Map<string, string>();
    const fakeDocument = {
      documentElement: {
        dataset: {} as Record<string, string>,
        style: {
          setProperty: (name: string, value: string) => properties.set(name, value),
          getPropertyValue: (name: string) => properties.get(name) ?? "",
        },
      },
    };
    vi.stubGlobal("document", fakeDocument);
    expect(on).toHaveBeenCalledWith("instance:apply-host-theme", expect.any(Function));
    const listener = on.mock.calls.find((call) => call[0] === "instance:apply-host-theme")?.[1] as (
      event: unknown,
      payload: unknown,
    ) => void;
    listener(undefined, {
      scheme: "dark",
      tokens: {
        bg: "#0a0a0a",
        accent: "oklch(0.588 0.217 264)",
        "not-a-token": "#ffffff",
        text: "red; background: url(evil)",
      },
    });
    const root = fakeDocument.documentElement;
    expect(root.dataset["desktopHost"]).toBe("ctox");
    expect(root.dataset["theme"]).toBe("dark");
    expect(root.style.getPropertyValue("--ctox-host-bg")).toBe("#0a0a0a");
    expect(root.style.getPropertyValue("--ctox-host-accent")).toBe("oklch(0.588 0.217 264)");
    expect(root.style.getPropertyValue("--ctox-host-not-a-token")).toBe("");
    expect(root.style.getPropertyValue("--ctox-host-text")).toBe("");

    // Malformed payloads never touch the document.
    listener(undefined, { scheme: "neon" });
    expect(root.dataset["theme"]).toBe("dark");
    vi.unstubAllGlobals();
  });
});
