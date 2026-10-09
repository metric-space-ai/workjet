import { describe, expect, it, vi } from "vite-plus/test";
import { NativeAccountCalendar } from "./nativeAccountCalendar";
import { requestWorkjetProjectControl } from "../workjetProjectControl";
const accounts = { ok: true as const, truncated: true, accounts: [{ id: "mine@example.test", calendar_id: "account:mine", label: "Calendar", supported: true }] };
describe("account calendars on the authenticated guest", () => {
  it("uses the selected instance and read-only correlated control without an MCP registration", async () => {
    const control = vi.fn<typeof requestWorkjetProjectControl>().mockImplementation(async (_, request) => {
      if (request.action === "project.calendar.accounts.read") return { _tag: "completed", response: { ...request, calendar: accounts } };
      if (request.action === "project.calendar.events.read") return { _tag: "completed", response: { ...request, calendar: { ok: true, truncated: false, events: [], synced_at_ms: 3 } } };
      return { _tag: "failed", code: "unsupported" };
    });
    const calendar = new NativeAccountCalendar("managed:selected-tenant", () => true, control);
    expect(await calendar.accounts()).toEqual(accounts);
    expect(await calendar.events(accounts.accounts[0]!.id, 1, 2)).toMatchObject({ synced_at_ms: 3 });
    expect(control.mock.calls.map(call => call[0])).toEqual(["managed:selected-tenant", "managed:selected-tenant"]);
    expect(control.mock.calls[0]![1]).not.toHaveProperty("actor");
    expect(control.mock.calls[0]![1]).not.toHaveProperty("connectionId");
  });
  it("rejects receipts after changing instance and never falls back to another authority", async () => {
    let current = true;
    const control = vi.fn<typeof requestWorkjetProjectControl>().mockImplementation(async (_, request) => {
      current = false;
      if (request.action !== "project.calendar.accounts.read") throw new Error("wrong action");
      return { _tag: "completed", response: { ...request, calendar: accounts } };
    });
    await expect(new NativeAccountCalendar("instance-1", () => current, control).accounts()).rejects.toThrow("instance changed");
    expect(control).toHaveBeenCalledTimes(1);
    await expect(new NativeAccountCalendar("instance-2", () => false, control).accounts()).rejects.toThrow("instance changed");
    expect(control).toHaveBeenCalledTimes(1);
  });
  it("keeps authentication and unsupported-shell failures visible", async () => {
    const control = vi.fn<typeof requestWorkjetProjectControl>().mockResolvedValue({ _tag: "failed", code: "unsupported" });
    await expect(new NativeAccountCalendar("instance-1", () => true, control).accounts()).rejects.toThrow("Business OS shell");
    expect(control).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign command IDs, account receipts and unknown sensitive fields", async () => {
    const control = vi.fn<typeof requestWorkjetProjectControl>().mockImplementation(async (_, request) => {
      if (request.action !== "project.calendar.accounts.read") throw new Error("wrong action");
      return { _tag: "completed", response: { ...request, commandId: "other" as typeof request.commandId, calendar: accounts } };
    });
    await expect(new NativeAccountCalendar("instance", () => true, control).accounts()).rejects.toThrow("does not match");
    control.mockImplementation(async (_, request) => {
      if (request.action !== "project.calendar.events.read") throw new Error("wrong action");
      return { _tag: "completed", response: { ...request, accountId: "foreign", calendar: { ok: true, truncated: false, events: [], synced_at_ms: 3 } } };
    });
    await expect(new NativeAccountCalendar("instance", () => true, control).events("mine", 1, 2)).rejects.toThrow("does not match");
  });
});
