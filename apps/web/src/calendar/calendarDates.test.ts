import { describe, expect, it } from "vite-plus/test";
import {
  addDays,
  addMonths,
  calendarLocale,
  formatClockTime,
  formatDateKey,
  formatDateKeyRange,
  formatHourLabel,
  instantOf,
  isoWeekNumber,
  localeWeekStart,
  resolveWeekStart,
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

describe("calendar formatting (de-DE)", () => {
  // 2026-10-12 13:00 UTC
  const oneOClock = Date.UTC(2026, 9, 12, 13, 0);
  // ICU separates range halves and AM/PM with (narrow) thin spaces.
  const plain = (text: string) => text.replace(/[\u2009\u202f]/g, " ");

  it("writes German month and weekday names regardless of the browser locale", () => {
    expect(formatDateKey("2026-10-12", { month: "long", year: "numeric" })).toBe("Oktober 2026");
    expect(formatDateKey("2026-10-12", { weekday: "short" })).toBe("Mo");
    expect(formatDateKey("2026-10-12", { weekday: "narrow" })).toBe("M");
  });

  it("formats week ranges the German way", () => {
    expect(plain(formatDateKeyRange("2026-10-12", "2026-10-18"))).toBe("12.–18. Okt. 2026");
    expect(plain(formatDateKeyRange("2026-10-26", "2026-11-01"))).toBe("26. Okt. – 1. Nov. 2026");
    expect(plain(formatDateKeyRange("2026-12-28", "2027-01-03"))).toBe(
      "28. Dez. 2026 – 3. Jan. 2027",
    );
  });

  it("uses 24-hour times by default and 12-hour only on request", () => {
    expect(formatClockTime(oneOClock, "locale", "UTC")).toBe("13:00");
    expect(formatClockTime(oneOClock, "24-hour", "UTC")).toBe("13:00");
    expect(formatClockTime(Date.UTC(2026, 9, 12, 9, 5), "locale", "UTC")).toBe("09:05");
    expect(plain(formatClockTime(oneOClock, "12-hour", "UTC"))).toBe("1:00 PM");
    expect(formatHourLabel(9)).toBe("09:00");
    expect(formatHourLabel(13, "24-hour")).toBe("13:00");
    expect(plain(formatHourLabel(13, "12-hour"))).toBe("1 PM");
  });

  it("starts weeks on Sunday when asked", () => {
    expect(startOfWeek("2026-10-14", "sunday")).toBe("2026-10-11");
    expect(startOfWeek("2026-10-11", "sunday")).toBe("2026-10-11");
    expect(monthGrid("2026-02-01", "sunday")[0]).toBe("2026-02-01");
    expect(monthGrid("2026-10-01", "sunday")[0]).toBe("2026-09-27");
  });

  it("numbers calendar weeks per ISO 8601", () => {
    expect(isoWeekNumber("2026-10-12")).toBe(42);
    expect(isoWeekNumber("2027-01-01")).toBe(53);
    expect(isoWeekNumber("2026-01-01")).toBe(1);
    expect(isoWeekNumber("2024-12-30")).toBe(1);
  });
});

describe("calendar locale follows the UI language", () => {
  const plain = (text: string) => text.replace(/[\u2009\u202f]/g, " ");
  const oneOClock = Date.UTC(2026, 9, 12, 13, 0);

  it("maps UI languages to locales, keeping a matching browser region", () => {
    expect(calendarLocale("de")).toBe("de-DE");
    expect(calendarLocale("de", "en-US")).toBe("de-DE");
    expect(calendarLocale("de", "de-AT")).toBe("de-AT");
    expect(calendarLocale("en")).toBe("en-US");
    expect(calendarLocale("en", "en-GB")).toBe("en-GB");
    expect(calendarLocale("fr")).toBe("fr");
  });

  it("derives week start from the locale unless overridden", () => {
    expect(localeWeekStart("de-DE")).toBe("monday");
    expect(localeWeekStart("en-GB")).toBe("monday");
    expect(localeWeekStart("en-US")).toBe("sunday");
    expect(resolveWeekStart("locale", "en-US")).toBe("sunday");
    expect(resolveWeekStart("monday", "en-US")).toBe("monday");
  });

  it("formats English locales their own way", () => {
    expect(formatDateKey("2026-10-12", { month: "long", year: "numeric" }, "en-US")).toBe(
      "October 2026",
    );
    expect(plain(formatDateKeyRange("2026-10-12", "2026-10-18", "en-US"))).toBe(
      "Oct 12 – 18, 2026",
    );
    expect(plain(formatClockTime(oneOClock, "locale", "UTC", "en-US"))).toBe("1:00 PM");
    expect(formatClockTime(oneOClock, "locale", "UTC", "en-GB")).toBe("13:00");
    expect(formatClockTime(oneOClock, "24-hour", "UTC", "en-US")).toBe("13:00");
    expect(plain(formatClockTime(oneOClock, "12-hour", "UTC", "de-DE"))).toMatch(
      /^1:00 (PM|nachm\.)$/,
    );
    expect(plain(formatHourLabel(13, "locale", "en-US"))).toBe("1 PM");
    expect(formatHourLabel(13, "locale", "en-GB")).toBe("13:00");
  });
});
