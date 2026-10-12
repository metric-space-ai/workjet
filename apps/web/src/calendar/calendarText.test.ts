import { describe, expect, it } from "vite-plus/test";
import { CALENDAR_TEXT, calendarText } from "./calendarText";

describe("calendarText", () => {
  it("resolves UI languages and regional locales", () => {
    expect(calendarText("de")).toBe(CALENDAR_TEXT.de);
    expect(calendarText("de-AT")).toBe(CALENDAR_TEXT.de);
    expect(calendarText("en-GB")).toBe(CALENDAR_TEXT.en);
  });
  it("falls back to English for languages without strings yet", () => {
    expect(calendarText("fr-FR")).toBe(CALENDAR_TEXT.en);
  });
  it("keeps every language complete", () => {
    expect(Object.keys(CALENDAR_TEXT.en).toSorted()).toEqual(
      Object.keys(CALENDAR_TEXT.de).toSorted(),
    );
    expect(CALENDAR_TEXT.en.more(2)).toBe("2 more");
    expect(CALENDAR_TEXT.de.more(2)).toBe("2 weitere");
  });
});
