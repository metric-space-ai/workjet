import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkjetNativeProviderAccount } from "@workjet/contracts";
import { NativeProviderLimits } from "./NativeProviderLimits";

type Quota = WorkjetNativeProviderAccount["reportedQuota"];
const now = 1_800_000_000_000;
function html(quota: Quota) {
  vi.spyOn(Date, "now").mockReturnValue(now);
  return renderToStaticMarkup(<NativeProviderLimits quota={quota} />);
}
afterEach(() => vi.restoreAllMocks());
describe("native reported limits", () => {
  it("keeps unknown and old-server data separate from a storage read failure", () => {
    expect(html(undefined)).toContain("has not reported limits");
    expect(html({ state: "unknown" })).toContain("—");
    const failed = html({ state: "unavailable", errorClass: "quota_read_failed" });
    expect(failed).toContain("quota_read_failed");
    expect(failed).not.toContain("Credentials rejected");
    expect(failed).not.toContain("%");
  });
  it("shows actual five-hour and seven-day utilization with observation and reset times", () => {
    const result = html({ state: "reported", observedAtMs: now - 1000, windows: [
      { kind: "five_hour", status: "allowed", resetAtMs: now + 1000, utilization: 0.25 },
      { kind: "seven_day", status: "rejected", resetAtMs: now + 2000, utilization: 1 },
    ] });
    expect(result).toContain("5h · 25% used");
    expect(result).toContain("7d · 100% used");
    expect(result).toContain("Last reported");
    expect(result).toContain("Reset");
    expect(result).toContain("text-amber-500");
  });
  it("marks each expired window without presenting its old percentage as current", () => {
    const result = html({ state: "reported", observedAtMs: now - 3000, windows: [
      { kind: "five_hour", status: "allowed", resetAtMs: now - 1000, utilization: 0.25 },
      { kind: "seven_day", status: "allowed", resetAtMs: now + 2000, utilization: 0.75 },
    ] });
    expect(result).toContain(">5h · expired</span>");
    expect(result).not.toContain(">5h · 25% used</span>");
    expect(result).toContain("This observation has expired.");
    expect(result).toContain("7d · 75% used");
  });
  it("never infers a percentage from allowed or rejected status alone", () => {
    const result = html({ state: "reported", observedAtMs: now - 1000, windows: [
      { kind: "five_hour", status: "allowed", resetAtMs: now + 1000, utilization: null },
      { kind: "seven_day", status: "rejected", resetAtMs: now + 2000, utilization: null },
    ] });
    expect(result).toContain("5h · —");
    expect(result).toContain("7d · limit reached");
    expect(result).toContain("utilization not supplied");
    expect(result).not.toContain("%");
  });
});
