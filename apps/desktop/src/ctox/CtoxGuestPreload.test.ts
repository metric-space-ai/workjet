// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it, vi } from "vite-plus/test";

const exposeInMainWorld = vi.fn();
const send = vi.fn();

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { send },
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
});
