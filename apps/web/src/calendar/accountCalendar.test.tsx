import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkjetCalendarEvent } from "@workjet/contracts";
import { buildAccountEvents, ProjectCalendar } from "../components/ProjectCalendar";
const event: WorkjetCalendarEvent = {
  id: "owned-event", calendar_id: "owned-calendar", account_id: "owned-account", kind: "synced",
  title: "Account appointment", start_ms: Date.parse("2026-10-08T23:00:00Z"),
  end_ms: Date.parse("2026-10-10T00:00:00Z"), all_day: false, timezone: "UTC", revision: 1,
};
describe("connected account calendar", () => {
  it("splits overnight events, preserves exclusive midnight ends and opens the original occurrence", () => {
    let opened: WorkjetCalendarEvent | null = null;
    const rows = buildAccountEvents([event], "2026-10-08", "2026-10-11", "UTC", (value) => { opened = value; });
    expect(rows.map((row) => row.date)).toEqual(["2026-10-08", "2026-10-09"]);
    expect(rows[0]!.endMs - rows[0]!.startMs).toBe(3_600_000);
    expect(rows[1]!.minutes).toBe(0);
    rows[1]!.onOpen();
    expect(opened).toBe(event);
  });
  it("renders actual account events and explicit partial sync in day, week and month", () => {
    for (const initialView of ["day", "week", "month"] as const) {
      const html = renderToStaticMarkup(<ProjectCalendar projects={[]} initialDate="2026-10-09"
        initialView={initialView} accountEvents={[event]} accountCalendars={[{
          id: "owned-calendar", label: "My account", status: "ready", truncated: true, syncedAtMs: 1,
        }]} />);
      expect(html).toContain("Account appointment");
      expect(html).toContain("My account");
      expect(html).toContain("Partial sync");
    }
  });
  it("binds provider project IDs to local project keys without admitting foreign projects", () => {
    const projects = [{ id: "native-project", key: "instance:native-project", title: "Project", local: null, native: true, onOpen: () => {} }];
    const rows = buildAccountEvents([
      { ...event, project_id: "native-project" },
      { ...event, id: "foreign-event", project_id: "foreign-project" },
    ], "2026-10-08", "2026-10-08", "UTC", () => {}, projects);
    expect(rows.map((row) => row.projectKey)).toEqual(["instance:native-project", ""]);
  });
  it("keeps all-day occurrences in the all-day lane", () => {
    const html = renderToStaticMarkup(<ProjectCalendar projects={[]} initialDate="2026-10-09"
      initialView="day" accountEvents={[{ ...event, all_day: true }]} />);
    expect(html).toContain('aria-label="All-day events"');
    expect(html).toContain("all-day");
  });
});
