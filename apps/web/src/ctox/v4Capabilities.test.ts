// Instance restart on V4 before M7: `ctox.maintenance.restart` is offered only when hello_ok grants
// it and the actor is admin; an `unavailable` answer hides it for the session. V3 is unchanged.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CTOX_MAINTENANCE_RESTART, CtoxV4AppError } from "@workjet/shared/ctoxV4AppData";
import { bindCtoxClient, type CtoxAppApi } from "./ctoxClient";
import { ctoxInstanceRestartOffered, restartCtoxInstance } from "./instanceAccess";
import {
  bindV4GrantedCapabilities,
  ctoxRouteOffered,
  resetV4CapabilitiesForTest,
  v4GrantedCapabilities,
} from "./v4Capabilities";

const unavailableApi = (role: string) =>
  ({
    version: "4.0",
    app: { id: "workjet" },
    actor: { id: "u-1", role },
    command: vi.fn(() => ({
      local: Promise.reject(new CtoxV4AppError("unavailable")),
      result: new Promise(() => {}),
      status: { subscribe: () => () => {} },
    })),
  }) as unknown as CtoxAppApi & { command: ReturnType<typeof vi.fn> };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetV4CapabilitiesForTest();
});

describe("restart offer", () => {
  it("V4 without the grant: not offered", () => {
    cleanups.push(bindCtoxClient("wj-r-none", unavailableApi("admin")));
    expect(ctoxInstanceRestartOffered("wj-r-none")).toBe(false);
    cleanups.push(bindV4GrantedCapabilities("wj-r-none", () => []));
    expect(ctoxInstanceRestartOffered("wj-r-none")).toBe(false);
  });

  it("V4 with the grant: offered to admin only", () => {
    cleanups.push(bindCtoxClient("wj-r-admin", unavailableApi("admin")));
    cleanups.push(bindV4GrantedCapabilities("wj-r-admin", () => [CTOX_MAINTENANCE_RESTART]));
    expect(ctoxInstanceRestartOffered("wj-r-admin")).toBe(true);
    cleanups.push(bindCtoxClient("wj-r-user", unavailableApi("user")));
    cleanups.push(bindV4GrantedCapabilities("wj-r-user", () => [CTOX_MAINTENANCE_RESTART]));
    expect(ctoxInstanceRestartOffered("wj-r-user")).toBe(false);
  });

  it("an `unavailable` answer hides the restart for the session", async () => {
    const api = unavailableApi("admin");
    cleanups.push(bindCtoxClient("wj-r-gone", api));
    cleanups.push(bindV4GrantedCapabilities("wj-r-gone", () => [CTOX_MAINTENANCE_RESTART]));
    const v3Restart = vi.fn(async () => ({ ok: true as const }));
    expect(await restartCtoxInstance("wj-r-gone", { reason: "r", v3Restart })).toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(api.command).toHaveBeenCalledWith(CTOX_MAINTENANCE_RESTART, { reason: "r" }, undefined);
    expect(v3Restart).not.toHaveBeenCalled();
    expect(ctoxInstanceRestartOffered("wj-r-gone")).toBe(false);
  });

  it("V4 restart without an explicit list reads the hello_ok grant, never sends without it", async () => {
    const api = unavailableApi("admin");
    cleanups.push(bindCtoxClient("wj-r-nogrant", api));
    const v3Restart = vi.fn(async () => ({ ok: true as const }));
    expect(await restartCtoxInstance("wj-r-nogrant", { reason: "r", v3Restart })).toEqual({
      ok: false,
      code: "capability_missing",
    });
    expect(api.command).not.toHaveBeenCalled();
  });

  it("V3 is unchanged: offered, desktop path", async () => {
    expect(ctoxInstanceRestartOffered("wj-r-v3")).toBe(true);
    expect(ctoxRouteOffered("wj-r-v3", CTOX_MAINTENANCE_RESTART)).toBe(true);
    const v3Restart = vi.fn(async () => ({ ok: true as const }));
    expect(await restartCtoxInstance("wj-r-v3", { reason: "r", v3Restart })).toEqual({ ok: true });
    expect(v3Restart).toHaveBeenCalledTimes(1);
  });

  it("a grant reader that throws reads as no grant", () => {
    cleanups.push(bindCtoxClient("wj-r-throw", unavailableApi("admin")));
    cleanups.push(
      bindV4GrantedCapabilities("wj-r-throw", () => {
        throw new Error("closed");
      }),
    );
    expect(v4GrantedCapabilities("wj-r-throw")).toBeNull();
    expect(ctoxInstanceRestartOffered("wj-r-throw")).toBe(false);
  });
});
