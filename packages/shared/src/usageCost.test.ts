import { describe, expect, it } from "vite-plus/test";
import { formatUsageCost } from "./usageFormat.ts";

describe("usage cost labels", () => {
  it("distinguishes unknown prices, partial known totals and known zero cost", () => {
    expect(formatUsageCost(0, 1)).toBe("Unbekannt");
    expect(formatUsageCost(3, 1)).toBe("$3.00 + unbekannt");
    expect(formatUsageCost(0, 0)).toBe("$0.00");
    expect(formatUsageCost(3, 0)).toBe("$3.00");
  });
});
