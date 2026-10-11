import { describe, expect, it } from "vite-plus/test";

import { formatUsageDateTime, formatUsageDay, formatUsageHour } from "./usageFormatDe";

describe("Verbrauch: deutsche Datumsangaben", () => {
  it("formats days, hours and instants in German", () => {
    expect(formatUsageDay("2026-08-07")).toBe("7. Aug.");
    expect(formatUsageDay("kein-datum")).toBe("kein-datum");
    expect(formatUsageHour("2026-10-11T14:00:00Z", "UTC")).toBe("14 Uhr");
    expect(formatUsageDateTime("2026-10-11T14:00:00Z", "UTC")).toBe("11. Okt., 14 Uhr");
  });
});
