import type { WorkjetGatewayProvider, WorkjetGatewayQuotaWindow } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { normalizeModelsQuota } from "./WorkjetModelsQuota";

const now = 1_000_000;
const window = (patch: Partial<WorkjetGatewayQuotaWindow> = {}): WorkjetGatewayQuotaWindow => ({
  name: "primary_window",
  remainingPercent: 100,
  resetsAtMs: now + 3600_000,
  observedAtMs: now,
  modelPattern: null,
  notInPlan: false,
  unlimited: false,
  toolOnly: false,
  boostPermille: null,
  ...patch,
});
const raw = (
  field: NonNullable<WorkjetGatewayQuotaWindow["source"]>["field"],
  value: number | null,
  windowSeconds: number | null,
  status: number | null = null,
) => ({ field, value, windowSeconds, status });
const normalize = (provider: WorkjetGatewayProvider, patch: Partial<WorkjetGatewayQuotaWindow>) =>
  normalizeModelsQuota(provider, [window(patch)], now)[0]!;

describe("provider quota evidence → remaining", () => {
  it.each([
    ["claude", "five_hour", raw("utilization", 0, 18_000), 100, "Kurzfristig"],
    ["claude", "seven_day", raw("utilization", 1, 604_800), 99, "7 Tage"],
    ["codex", "primary_window", raw("used_percent", 57, 18_000), 43, "Kurzfristig"],
    ["codex", "secondary_window", raw("used_percent", 100, 604_800), 0, "7 Tage"],
    ["zai", "TOKENS_LIMIT_0", raw("percentage", 5, 18_000), 95, "Kurzfristig"],
    ["zai", "TOKENS_LIMIT_1", raw("percentage", 42, 604_800), 58, "7 Tage"],
    ["zai", "TOKENS_LIMIT_1", raw("percentage", 42, 2_592_000), 58, "30 Tage"],
    [
      "minimax",
      "general_interval",
      raw("current_interval_remaining_percent", 80, 18_000),
      80,
      "Kurzfristig",
    ],
    ["minimax", "general_weekly", raw("current_weekly_remaining_percent", 0, 604_800), 0, "7 Tage"],
  ] as const)("%s %s uses its raw field once", (provider, name, source, expected, label) => {
    // Deliberately conflicting old field proves the UI uses the raw reading.
    const result = normalize(provider, { name, source, remainingPercent: 100 });
    expect(result.remainingPercent).toBe(expected);
    expect(result.label).toBe(label);
    expect(result.exhausted).toBe(expected === 0);
  });
  it("MiniMax 100% consumed / exhausted status gives zero REST, not 100", () => {
    // usage_count alone is ambiguous; status 2 is vendor-documented exhaustion.
    const consumedFixture = {
      current_interval_total_count: 100,
      current_interval_usage_count: 100,
      current_interval_status: 2,
      current_interval_remaining_percent: 100,
    };
    const result = normalize("minimax", {
      name: "general_interval",
      source: raw(
        "current_interval_remaining_percent",
        consumedFixture.current_interval_remaining_percent,
        18_000,
        consumedFixture.current_interval_status,
      ),
    });
    expect(result.remainingPercent).toBe(0);
    expect(result.exhausted).toBe(true);
    expect(result.tone).toBe("red");
  });
  it("does not infer MiniMax direction from ambiguous counts or a missing percentage", () => {
    const result = normalize("minimax", {
      name: "general_interval",
      source: raw("current_interval_remaining_percent", null, 18_000),
    });
    expect(result.remainingPercent).toBeNull();
    expect(result.unknownReason).toContain("eindeutigen Restwert");
    expect(result.exhausted).toBe(false);
  });
  it.each(["xai", "kimi"] as const)("%s has no quota reading", (provider) => {
    expect(normalizeModelsQuota(provider, [], now)).toEqual([]);
    const unexpected = normalize(provider, { source: raw("used_percent", 0, 18_000) });
    expect(unexpected.remainingPercent).toBeNull();
    expect(unexpected.unknownReason).toContain("Richtung");
  });
  it("never guesses Z.ai duration from list order or time until reset", () => {
    for (const [unit, number, label] of [
      [3, 5, "Kurzfristig"],
      [6, 1, "7 Tage"],
      [5, 1, "30 Tage"],
      [6, 7, "unbekannt"],
      [99, 1, "unbekannt"],
    ] as const) {
      expect(
        normalize("zai", {
          name: "TOKENS_LIMIT_0",
          source: { ...raw("percentage", 42, null), unit, number },
        }).label,
      ).toBe(label);
    }
    const quotas = [
      window({ name: "TOKENS_LIMIT_1", source: raw("percentage", 42, 604_800) }),
      window({ name: "TOKENS_LIMIT_0", source: raw("percentage", 5, 18_000) }),
    ];
    expect(normalizeModelsQuota("zai", quotas, now).map((w) => w.label)).toEqual([
      "7 Tage",
      "Kurzfristig",
    ]);
    expect(normalize("zai", { name: "TOKENS_LIMIT_0" }).label).toBe("unbekannt");
    expect(normalize("zai", { name: "TOKENS_LIMIT_0" }).tooltip).toContain(
      "Dauer vom Host nicht übermittelt",
    );
  });
  it.each(["claude", "codex", "zai", "minimax"] as const)(
    "%s legacy host REST is never inverted twice",
    (provider) => {
      expect(normalize(provider, { remainingPercent: 43 }).remainingPercent).toBe(43);
    },
  );
  it.each([
    [100, "green"],
    [21, "green"],
    [20, "yellow"],
    [6, "yellow"],
    [5, "red"],
    [0, "red"],
  ] as const)("%s%% REST has %s warning level", (remainingPercent, tone) => {
    expect(normalize("codex", { remainingPercent }).tone).toBe(tone);
  });
  it("ages readings, keeps known exhaustion to reset and rejects future observations", () => {
    const zero = window({ remainingPercent: 0 });
    expect(normalizeModelsQuota("codex", [zero], now + 300_000)[0]?.remainingPercent).toBe(0);
    expect(normalizeModelsQuota("codex", [zero], zero.resetsAtMs!)[0]?.remainingPercent).toBeNull();
    expect(normalize("codex", { observedAtMs: now + 1 }).remainingPercent).toBeNull();
    expect(
      normalizeModelsQuota("codex", [window()], now + 300_000)[0]?.remainingPercent,
    ).toBeNull();
  });
  it("keeps tool and model scope, no-plan and unlimited out of whole-account exhaustion", () => {
    expect(normalizeModelsQuota("minimax", [window({ toolOnly: true })], now)).toEqual([]);
    expect(normalize("claude", { name: "seven_day_opus", remainingPercent: 0 }).accountWide).toBe(
      false,
    );
    expect(normalize("minimax", { notInPlan: true, remainingPercent: 0 }).exhausted).toBe(false);
    expect(normalize("minimax", { unlimited: true, remainingPercent: 0 }).exhausted).toBe(false);
    expect(
      normalize("minimax", { remainingPercent: 135, boostPermille: 1500 }).remainingPercent,
    ).toBe(90);
  });
});
