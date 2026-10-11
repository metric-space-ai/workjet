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
const quota: Quota = { state: "reported", observedAtMs: now - 1000, windows: [
  { kind: "five_hour", status: "allowed", resetAtMs: now + 1000, utilization: 0.25 },
  { kind: "seven_day", status: "allowed", resetAtMs: now + 2000, utilization: 0.75 },
] };
function render(value: Quota) {
  hooks.beginRender();
  return renderToStaticMarkup(NativeProviderLimits({ quota: value }));
}
beforeEach(() => { hooks.reset(); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); hooks.reset(); });

describe("reported limit expiration while Models remains open", () => {
  it("expires each window at its own reset without requiring navigation", async () => {
    expect(render(quota)).toContain("5h · 25% used");
    await vi.advanceTimersByTimeAsync(1001);
    const first = render(quota);
    expect(first).toContain(">5h · expired</span>");
    expect(first).toContain("7d · 75% used");
    await vi.advanceTimersByTimeAsync(1000);
    const second = render(quota);
    expect(second).toContain(">7d · expired</span>");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels the old expiry timer when the receipt becomes unknown", () => {
    render(quota);
    expect(vi.getTimerCount()).toBe(1);
    expect(render({ state: "unknown" })).toContain("has not reported limits");
    expect(vi.getTimerCount()).toBe(0);
  });
});
