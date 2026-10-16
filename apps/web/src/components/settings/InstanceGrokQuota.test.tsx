import { renderToStaticMarkup } from "react-dom/server";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkjetNativeProviderAccount } from "@workjet/contracts";
import { NativeProviderLimits } from "./NativeProviderLimits";
import { instanceXaiQuota } from "./WorkjetModelsQuota";

// ctox#872: the provider registry reports Grok quota as unknown, unavailable or a
// weekly/monthly period next to the existing Claude window branch.
type Quota = WorkjetNativeProviderAccount["reportedQuota"];
const decodeAccount = Schema.decodeUnknownSync(WorkjetNativeProviderAccount);
const now = 1_800_000_000_000;
const reference = {
  accountId: "196a89ba-ee86-4413-885c-04ca60e6f291",
  holderInstanceId: "322084e5-8239-48d7-b3c5-c5178fbe5822",
  accountRevision: 3,
};
// Today's registry entry: no reportedQuota field at all.
const todayAccount = {
  id: reference.accountId,
  holder: { kind: "ctox_instance", id: reference.holderInstanceId },
  provider: "xai",
  enabled: true,
  credentialReady: true,
  revision: 3,
  observedAtMs: 1,
  nativeAccountReference: reference,
  modelCatalogObserved: true,
  modelCatalog: {
    observed: true,
    fresh: true,
    models: ["grok-4.7"],
    lastSuccessAtMs: 1,
    lastAttempt: {
      checkedAtMs: 1,
      httpStatus: 200,
      elapsedMs: 100,
      retryAfterSeconds: null,
      failure: null,
      success: true,
    },
  },
  excludedModels: [],
  effectiveModels: ["grok-4.7"],
  inferenceVerified: false,
};
const registryWith = (reportedQuota?: unknown) => ({
  accounts: [
    decodeAccount(reportedQuota === undefined ? todayAccount : { ...todayAccount, reportedQuota }),
  ],
});
function html(quota: Quota) {
  vi.spyOn(Date, "now").mockReturnValue(now);
  return renderToStaticMarkup(<NativeProviderLimits provider="xai" quota={quota} />);
}
const period = (value: "weekly" | "monthly", used: number) => ({
  state: "reported",
  period: value,
  used_percent: used,
  observedAtMs: now - 1000,
  resetAtMs: now + 3 * 86_400_000,
});
afterEach(() => vi.restoreAllMocks());

describe("instance Grok quota decoder (ctox#872)", () => {
  it("decodes all three forms and strips private fields", () => {
    expect(registryWith({ state: "unknown" }).accounts[0]!.reportedQuota).toEqual({
      state: "unknown",
    });
    expect(
      registryWith({ state: "unavailable", errorClass: "quota_read_failed" }).accounts[0]!
        .reportedQuota,
    ).toEqual({ state: "unavailable", errorClass: "quota_read_failed" });
    expect(
      registryWith({ ...period("weekly", 42.5), private: "discard" }).accounts[0]!.reportedQuota,
    ).toEqual(period("weekly", 42.5));
    expect(registryWith(period("monthly", 10)).accounts[0]!.reportedQuota).toEqual(
      period("monthly", 10),
    );
  });
  it("rejects invented periods, percentages and inconsistent instants", () => {
    for (const invalid of [
      { ...period("weekly", 1), period: "daily" },
      period("weekly", 101),
      period("weekly", -1),
      { ...period("weekly", 1), resetAtMs: now - 1000 },
      { ...period("weekly", 1), resetAtMs: now + 41 * 86_400_000 },
      { ...period("weekly", 1), observedAtMs: undefined },
      { state: "unavailable", errorClass: "credentials_rejected" },
    ])
      expect(() => registryWith(invalid)).toThrow();
  });
});

describe("instance Grok quota presentation", () => {
  it("renders weekly like the local Grok bar: Woche, remaining share, reset instant", () => {
    const result = html(period("weekly", 25) as Quota);
    expect(result).toContain("Woche");
    expect(result).toContain('role="meter"');
    expect(result).toContain('aria-valuenow="75"');
    expect(result).toContain(">75%</span>");
    expect(result).toContain("Reset");
  });
  it("renders monthly as Monat and an exhausted period as Limit erreicht", () => {
    const result = html(period("monthly", 100) as Quota);
    expect(result).toContain("Monat");
    expect(result).toContain('aria-valuenow="0"');
    expect(result).toContain("Limit erreicht");
  });
  it("shows only the status dot for unavailable, no sentence", () => {
    const result = html({ state: "unavailable", errorClass: "quota_read_failed" });
    expect(result).toContain('data-slot="row-status"');
    expect(result).not.toContain('role="meter"');
    expect(result.replace(/<[^>]*>/g, "")).toBe("");
  });
  it("shows nothing for unknown", () => {
    const result = html({ state: "unknown" });
    expect(result).not.toContain('data-slot="row-status"');
    expect(result).not.toContain('role="meter"');
    expect(result.replace(/<[^>]*>/g, "")).toBe("");
  });
  it("hands the Grok row the reading or the read failure, never unknown", () => {
    expect(instanceXaiQuota(registryWith(period("weekly", 25)))).toEqual(period("weekly", 25));
    expect(
      instanceXaiQuota(registryWith({ state: "unavailable", errorClass: "quota_read_failed" })),
    ).toEqual({ state: "unavailable", errorClass: "quota_read_failed" });
    expect(instanceXaiQuota(registryWith({ state: "unknown" }))).toBeUndefined();
  });
  it("leaves today's registry without a quota field unchanged: no chips on the Grok row", () => {
    const registry = registryWith();
    expect(registry.accounts[0]!.reportedQuota).toBeUndefined();
    expect(instanceXaiQuota(registry)).toBeUndefined();
    expect(instanceXaiQuota(undefined)).toBeUndefined();
  });
  it("keeps the Claude window branch unchanged", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const result = renderToStaticMarkup(
      <NativeProviderLimits
        provider="claude"
        quota={{
          state: "reported",
          observedAtMs: now - 1000,
          windows: [
            { kind: "seven_day", status: "allowed", resetAtMs: now + 1000, utilization: 0.25 },
          ],
        }}
      />,
    );
    expect(result).toContain("7 Tage");
    expect(result).toContain('aria-valuenow="75"');
  });
});
