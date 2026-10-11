import type { WorkjetNativeProviderAccount } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useEffect: reactHookHarness.useEffect, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
import { NativeProviderLimits } from "./NativeProviderLimits";

type Quota = WorkjetNativeProviderAccount["reportedQuota"];
const now = 1_800_000_000_000;
const quota: Quota = {
  state: "reported",
  observedAtMs: now - 1000,
  windows: [
    { kind: "five_hour", status: "allowed", resetAtMs: now + 1000, utilization: 0.25 },
    { kind: "seven_day", status: "allowed", resetAtMs: now + 2000, utilization: 0.75 },
  ],
};
function render(value: Quota) {
  hooks.beginRender();
  return renderToStaticMarkup(NativeProviderLimits({ provider: "claude", quota: value }));
}
beforeEach(() => {
  hooks.reset();
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  hooks.reset();
});

describe("reported limit expiration while Models remains open", () => {
  it("expires each window at its own reset without requiring navigation", async () => {
    expect(render(quota)).toContain('aria-valuenow="75"');
    await vi.advanceTimersByTimeAsync(1001);
    const first = render(quota);
    expect(first).toContain("abgelaufen");
    expect(first).toContain('aria-valuenow="25"');
    await vi.advanceTimersByTimeAsync(1000);
    const second = render(quota);
    expect(second).toContain("unbekannt");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ages a positive reading at the shared freshness boundary without navigation", async () => {
    const lasting: Quota = {
      state: "reported",
      observedAtMs: now,
      windows: [
        { kind: "five_hour", status: "allowed", resetAtMs: now + 3600_000, utilization: 0.25 },
      ],
    };
    expect(render(lasting)).toContain('aria-valuenow="75"');
    await vi.advanceTimersByTimeAsync(300_001);
    const stale = render(lasting);
    expect(stale).toContain("unbekannt");
    expect(stale).not.toContain('role="meter"');
    expect(vi.getTimerCount()).toBe(1);
  });
  it("cancels the old expiry timer when the receipt becomes unknown", () => {
    render(quota);
    expect(vi.getTimerCount()).toBe(1);
    expect(render({ state: "unknown" })).toContain("Keine Limits gemeldet");
    expect(vi.getTimerCount()).toBe(0);
  });
});
