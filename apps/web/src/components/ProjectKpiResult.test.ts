import { describe, expect, it } from "vite-plus/test";
import { formatKpiTime } from "./ProjectKpiResult";

describe("KPI calculation time", () => {
  it("uses a 24-hour clock in German and English", () => {
    const at = new Date(2026, 9, 12, 17, 5);
    expect(formatKpiTime(at, "de")).toBe("17:05");
    expect(formatKpiTime(at, "en")).toBe("17:05");
  });
});
