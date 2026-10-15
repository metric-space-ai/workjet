import { describe, expect, it } from "vite-plus/test";

import {
  formatUsageCostDe,
  formatUsageDateTime,
  formatUsageDay,
  formatUsageHour,
  formatUsagePercent,
  formatUsageTokens,
  formatUsageUsd,
} from "./usageFormatDe";

const plain = (value: string) => value.replace(/\u00a0/gu, " ");

describe("Verbrauch: deutsche Datumsangaben", () => {
  it("formats days, hours and instants in German", () => {
    expect(formatUsageDay("2026-08-07")).toBe("7. Aug.");
    expect(formatUsageDay("kein-datum")).toBe("kein-datum");
    expect(formatUsageHour("2026-10-11T14:00:00Z", "UTC")).toBe("14 Uhr");
    expect(formatUsageDateTime("2026-10-11T14:00:00Z", "UTC")).toBe("11. Okt., 14 Uhr");
  });
});

describe("Verbrauch: deutsche Zahlen", () => {
  it("formats amounts, tokens and shares in de-DE", () => {
    expect(plain(formatUsageUsd(1284.37))).toBe("1.284,37 $");
    expect(plain(formatUsageCostDe(12.5, 1))).toBe("12,50 $ + unbekannt");
    expect(formatUsageCostDe(0, 1)).toBe("Unbekannt");
    expect(formatUsageTokens(76_700_000)).toBe("76,7 Mio.");
    expect(formatUsageTokens(804_000)).toBe("804 Tsd.");
    expect(formatUsageTokens(1_500)).toBe("1,5 Tsd.");
    expect(formatUsageTokens(950)).toBe("950");
    expect(formatUsagePercent(0.123)).toBe("12,3 %");
  });
});
