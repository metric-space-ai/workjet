import { describe, it, expect } from "vite-plus/test";
import * as Schema from "effect/Schema";
import fixture from "./workjetCalendar.fixture.json" with { type: "json" };
import { WorkjetCalendarEvent, WorkjetCalendarEventsInput } from "./workjetCalendar.ts";
const decode = Schema.decodeUnknownSync(WorkjetCalendarEvent, { onExcessProperty: "error" });
describe("native calendar contract", () => {
  it("accepts and rejects the same event fixtures as native Rust and browser JS", () => {
    for (const item of fixture.valid_cases.filter((item) => item.type === "CalendarEvent"))
      expect(() => decode(item.value)).not.toThrow();
    for (const item of fixture.invalid_cases.filter((item) => item.type === "CalendarEvent"))
      expect(() => decode(item.value)).toThrow();
  });
  it("rejects unsafe and unbounded queries", () => {
    const read = Schema.decodeUnknownSync(WorkjetCalendarEventsInput);
    const target = { connectionId: "calendar-connection", instanceId: "instance" };
    expect(() => read({ target, accountId: "account", startMs: 0, endMs: 0 })).toThrow();
    expect(() =>
      read({ target, accountId: "account", startMs: 0, endMs: 401 * 86_400_000 }),
    ).toThrow();
  });
});
