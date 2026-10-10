import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@workjet/contracts";
import { ProjectCalendar, buildSessionEvents } from "./ProjectCalendar";
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

describe("native project session calendar", () => {
  const session = {
    id: "session-1",
    projectId: "ctox.dev",
    workingCopyId: "copy-1",
    computerId: "computer-1",
    threadId: null,
    codingSessionId: null,
    runStatus: "running" as const,
    fenceEpoch: 0,
    activeTransferId: null,
    createdAtMs: Date.parse("2026-10-07T08:00:00Z"),
    updatedAtMs: Date.parse("2026-10-08T09:00:00Z"),
  };
  it("uses the persisted start and exact project identity, without inventing a duration", () => {
    const events = buildSessionEvents([project("ctox.dev")], [session], "Europe/Berlin");
    expect(events).toHaveLength(1);
    expect(events[0]?.startMs).toBe(session.createdAtMs);
    expect(events[0]?.endMs).toBe(session.createdAtMs);
    expect(events[0]?.minutes).toBe(600);
    expect(events[0]?.title).toContain("ctox.dev");
    expect(buildSessionEvents([project("foreign-project")], [session], "Europe/Berlin")).toEqual(
      [],
    );
    const { createdAtMs: _start, ...legacy } = session;
    expect(buildSessionEvents([project("ctox.dev")], [legacy], "Europe/Berlin")).toEqual([]);
  });
  for (const initialView of ["day", "week", "month"] as const) {
    it(`renders actual sessions in ${initialView} with all-project/per-project selection`, () => {
      const html = renderToStaticMarkup(
        <ProjectCalendar
          initialView={initialView}
          initialDate="2026-10-07"
          projects={[project("ctox.dev")]}
          sessions={[session]}
        />,
      );
      expect(html).toContain("Session (running)");
      expect(html).toContain('aria-label="Calendar project"');
      expect(html).toContain("All projects");
    });
  }
  it("marks retained data stale when the native read fails", () => {
    const html = renderToStaticMarkup(
      <ProjectCalendar
        projects={[project("ctox.dev")]}
        initialDate="2026-10-07"
        sessions={[session]}
        sessionsStatus="unavailable"
      />,
    );
    expect(html).toContain("Previously loaded sessions may be out of date");
  });
});
