import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkjetNativeProviderAccount } from "@workjet/contracts";
import { NativeProviderLimits } from "./NativeProviderLimits";

type Quota = WorkjetNativeProviderAccount["reportedQuota"];
const now = 1_800_000_000_000;
function html(quota: Quota, provider = "claude") {
  vi.spyOn(Date, "now").mockReturnValue(now);
  return renderToStaticMarkup(<NativeProviderLimits provider={provider} quota={quota} />);
}
function reported(utilization: number | null, status: "allowed" | "rejected" = "allowed"): Quota {
  return {
    state: "reported",
    observedAtMs: now - 1000,
    windows: [{ kind: "five_hour", status, resetAtMs: now + 3600_000, utilization }],
  };
}
afterEach(() => vi.restoreAllMocks());
describe("native reported limits", () => {
  it("keeps unknown and old-server data separate from a storage read failure", () => {
    // #610: unknown limits render an empty cell, no "—" or caption.
    expect(html(undefined)).not.toContain("Keine Limits gemeldet");
    expect(html({ state: "unknown" })).not.toContain("—");
    const failed = html({ state: "unavailable", errorClass: "quota_read_failed" });
    expect(failed).not.toContain("Credentials rejected");
    expect(failed).not.toContain('role="meter"');
  });
  it("shares the remaining percentage, meter, window labels and evidence tooltip", () => {
    const result = html({
      state: "reported",
      observedAtMs: now - 1000,
      windows: [
        { kind: "five_hour", status: "allowed", resetAtMs: now + 1000, utilization: 0.25 },
        { kind: "seven_day", status: "rejected", resetAtMs: now + 2000, utilization: 1 },
      ],
    });
    expect(result).toContain("Kurzfristig");
    expect(result).toContain("5 h");
    expect(result).toContain("7 Tage");
    expect(result).toContain('aria-valuenow="75"');
    expect(result).toContain('style="width:75%"');
    expect(result).toContain(">75%</span>");
    expect(result).toContain("gemessen");
    expect(result).toContain("Reset");
    expect(result).toContain("Limit erreicht");
    expect(result).not.toContain("used");
  });
  it.each([
    [0, 100, "bg-emerald-500/80"],
    [0.8, 20, "bg-amber-500"],
    [0.95, 5, "bg-red-500"],
    [1, 0, "bg-red-500"],
  ] as const)("%s consumption shows %s percent remaining", (used, rest, tone) => {
    const result = html(reported(used));
    expect(result).toContain(`aria-valuenow="${rest}"`);
    expect(result).toContain(tone);
    expect(result.includes("Limit erreicht")).toBe(rest === 0);
  });
  it("does not infer exhaustion from rejected status or a missing reading", () => {
    expect(html(reported(0.25, "rejected"))).not.toContain("Limit erreicht");
    for (const status of ["allowed", "rejected"] as const) {
      const result = html(reported(null, status));
      expect(result).not.toContain('role="meter"');
      expect(result).not.toContain("Limit erreicht");
    }
  });
  it("keeps unqualified provider direction unknown", () => {
    const result = html(reported(1, "rejected"), "unqualified-provider");
    expect(result).not.toContain("Limit erreicht");
    expect(result).not.toContain('role="meter"');
  });
  it("removes old values at reset or the shared freshness boundary", () => {
    const expired = html({
      state: "reported",
      observedAtMs: now - 3000,
      windows: [{ kind: "five_hour", status: "allowed", resetAtMs: now - 1000, utilization: 0.25 }],
    });
    expect(expired).not.toContain('role="meter"');
    const stale = html({
      state: "reported",
      observedAtMs: now - 300_000,
      windows: [{ kind: "five_hour", status: "allowed", resetAtMs: now + 1000, utilization: 0.25 }],
    });
    expect(stale).not.toContain('role="meter"');
  });
});
