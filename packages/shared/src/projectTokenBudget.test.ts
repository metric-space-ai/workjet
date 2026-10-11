import { describe, expect, it } from "vite-plus/test";
import {
  parseTokenBudgetBillions,
  projectTokenCycle,
  projectTokenTotal,
  reachedTokenBudgetThresholds,
  tokenBudgetNotice,
} from "./projectTokenBudget";
describe("project token cycles", () => {
  it.each(["2,3", "2.3"])("parses %s in billions", (value) =>
    expect(parseTokenBudgetBillions(value)).toBe(2.3),
  );
  it("allows an unlimited budget and rejects excess precision", () => {
    expect(parseTokenBudgetBillions(" ")).toBeNull();
    expect(() => parseTokenBudgetBillions("2.34")).toThrow();
  });
  it("rolls over exactly at the regular meeting", () => {
    const meeting = { weekday: 3, time: "13:00", timezone: "Europe/Berlin" };
    const before = projectTokenCycle(Date.parse("2026-10-14T10:59:59Z"), meeting);
    const after = projectTokenCycle(Date.parse("2026-10-14T11:00:00Z"), meeting);
    expect(before.end).toBe(after.start);
    expect(after.end).toBe("2026-10-21T11:00:00.000Z");
  });
  it("uses Berlin calendar weeks and respects DST", () => {
    const before = projectTokenCycle(Date.parse("2026-10-25T22:59:59Z"), null);
    const after = projectTokenCycle(Date.parse("2026-10-25T23:00:00Z"), null);
    expect(before.start).toBe("2026-10-18T22:00:00.000Z");
    expect(before.end).toBe(after.start);
    expect(after.end).toBe("2026-11-01T23:00:00.000Z");
  });
  it("counts disjoint input and output without double-counting reasoning", () => {
    expect(
      projectTokenTotal({
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 30,
        outputTokens: 40,
        reasoningTokens: 15,
      }),
    ).toBe(100);
  });
  it("has no thresholds without a limit and exceeds only above 100%", () => {
    expect(reachedTokenBudgetThresholds(3e9, null)).toEqual([]);
    expect(reachedTokenBudgetThresholds(1_150_000_000, 2.3)).toEqual([50]);
    expect(reachedTokenBudgetThresholds(1e9, 1)).toEqual([50, 80, 90, 95, 98]);
    expect(reachedTokenBudgetThresholds(1e9 + 1, 1)).toEqual([50, 80, 90, 95, 98, 100]);
    expect(
      tokenBudgetNotice(
        1e9 + 1,
        1,
        100,
        "2026-10-14T11:00:00Z",
        Date.parse("2026-10-12T08:00:00Z"),
      ),
    ).toContain("Die Arbeit läuft weiter");
  });
});
