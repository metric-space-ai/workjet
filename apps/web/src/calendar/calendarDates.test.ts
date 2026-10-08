import { describe, expect, it } from "vite-plus/test";
import {
  addDays,
  addMonths,
  instantOf,
  isoWeekday,
  monthGrid,
  startOfWeek,
  weeklyOccurrences,
} from "./calendarDates";

describe("calendar date arithmetic", () => {
  it("moves across month and year boundaries without local offsets", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });

  it("starts weeks on Monday and reports ISO weekdays", () => {
    expect(isoWeekday("2026-10-05")).toBe(1);
    expect(isoWeekday("2026-10-11")).toBe(7);
    expect(startOfWeek("2026-10-08")).toBe("2026-10-05");
    expect(startOfWeek("2026-10-05")).toBe("2026-10-05");
  });

  it("builds six full weeks for every month", () => {
    const grid = monthGrid("2026-02-01");
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe("2026-01-26");
    expect(grid[41]).toBe("2026-03-08");
  });
});

describe("instants in a zone", () => {
  it("resolves wall-clock times with the zone's offset in force on that date", () => {
    // Berlin is UTC+2 before the October 2026 DST change and UTC+1 after it.
    expect(instantOf("2026-10-07", 9 * 60 + 30, "Europe/Berlin")).toBe(Date.UTC(2026, 9, 7, 7, 30));
    expect(instantOf("2026-10-28", 9 * 60 + 30, "Europe/Berlin")).toBe(
      Date.UTC(2026, 9, 28, 8, 30),
    );
  });
});

describe("weekly rules", () => {
  it("keeps the native weekday and wall-clock time and places occurrences in the display zone", () => {
    const occurrences = weeklyOccurrences(
      { weekday: 3, time: "09:30", timezone: "Europe/Berlin" },
      "2026-10-05",
      "2026-10-11",
      "UTC",
    );
    expect(occurrences).toEqual([
      { startMs: Date.UTC(2026, 9, 7, 7, 30), date: "2026-10-07", minutes: 450 },
    ]);
  });

  it("can move an occurrence onto the previous or next display-zone day", () => {
    // 23:00 on a Tuesday in New York is already Wednesday in UTC, so the display day moves with the zone.
    const occurrences = weeklyOccurrences(
      { weekday: 2, time: "23:00", timezone: "America/New_York" },
      "2026-10-07",
      "2026-10-07",
      "UTC",
    );
    expect(occurrences).toEqual([
      { startMs: Date.UTC(2026, 9, 7, 3, 0), date: "2026-10-07", minutes: 180 },
    ]);
  });

  it("returns every week in a range and nothing outside it", () => {
    const occurrences = weeklyOccurrences(
      { weekday: 1, time: "10:00", timezone: "UTC" },
      "2026-10-01",
      "2026-10-31",
      "UTC",
    );
    expect(occurrences.map((occurrence) => occurrence.date)).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
  });
});
