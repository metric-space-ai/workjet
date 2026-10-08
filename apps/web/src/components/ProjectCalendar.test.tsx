import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@workjet/contracts";
import { ProjectCalendar } from "./ProjectCalendar";
import type { GalleryProject } from "../projectOverview";

function project(id: string, meeting?: { weekday: number; time: string; timezone: string }) {
  return {
    key: `instance:${id}`,
    id,
    title: id,
    native: true,
    local: null,
    configuration: { id: ProjectId.make(id), title: id, ...(meeting ? { jourFixe: meeting } : {}) },
    onOpen: () => {},
  } satisfies GalleryProject & { onOpen: () => void };
}

describe("project calendar", () => {
  it("renders the anchored week with the project meetings as their own calendar", () => {
    const html = renderToStaticMarkup(
      <ProjectCalendar
        initialDate="2026-10-07"
        projects={[
          project("ctox.dev", { weekday: 3, time: "09:30", timezone: "Europe/Berlin" }),
          project("greppy.xyz", { weekday: 3, time: "08:00", timezone: "America/New_York" }),
        ]}
      />,
    );
    expect(html).toContain('aria-label="Calendar view"');
    expect(html).toContain("Project meetings");
    expect(html).toContain('data-calendar-day="2026-10-07"');
    expect(html).toContain('aria-label="ctox.dev, ');
    expect(html).toContain('aria-label="greppy.xyz, ');
    expect(html).toContain('title="ctox.dev · Europe/Berlin"');
    expect(html).toContain('title="greppy.xyz · America/New_York"');
  });

  it("offers the day, week, month and year views", () => {
    const html = renderToStaticMarkup(<ProjectCalendar projects={[]} initialDate="2026-10-07" />);
    for (const label of ["Day", "Week", "Month", "Year", "Today", "Previous", "Next"]) {
      expect(html).toContain(label);
    }
  });

  it("keeps projects with no regular meeting visible and does not manufacture appointments", () => {
    const html = renderToStaticMarkup(
      <ProjectCalendar initialDate="2026-10-07" projects={[project("miltonticket.app")]} />,
    );
    expect(html).toContain('aria-label="Projects without a regular meeting"');
    expect(html).toContain("miltonticket.app");
    expect(html).toContain('data-workjet-action="project.open.calendar:instance:miltonticket.app"');
    expect(html).not.toContain('title="miltonticket.app · ');
  });
});
