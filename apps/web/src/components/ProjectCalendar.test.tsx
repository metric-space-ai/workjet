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
    expect(html).toContain('aria-label="Kalenderansicht"');
    expect(html).toContain("Regeltermine");
    expect(html).toContain('data-calendar-day="2026-10-07"');
    expect(html).toContain('aria-label="ctox.dev, ');
    expect(html).toContain('aria-label="greppy.xyz, ');
    expect(html).toContain('title="ctox.dev · Europe/Berlin"');
    expect(html).toContain('title="greppy.xyz · America/New_York"');
  });

  it("speaks German dates and 24-hour times, and honours the week start", () => {
    const html = renderToStaticMarkup(
      <ProjectCalendar
        initialDate="2026-10-14"
        projects={[project("ctox.dev", { weekday: 3, time: "13:00", timezone: "UTC" })]}
      />,
    ).replace(/[\u2009\u202f]/g, " ");
    expect(html).toContain("12.–18. Okt. 2026 · KW 42");
    expect(html).toContain("Oktober 2026");
    expect(html).not.toMatch(/\b(AM|PM)\b/);
    expect(html).toContain("13:00");
    expect(html).not.toContain("October");

    const sunday = renderToStaticMarkup(
      <ProjectCalendar
        initialDate="2026-10-14"
        locale="en-US"
        weekStart="locale"
        projects={[project("ctox.dev", { weekday: 3, time: "13:00", timezone: "UTC" })]}
      />,
    ).replace(/[\u2009\u202f]/g, " ");
    expect(sunday).toContain("Oct 11 – 17, 2026 · Week 42");
    expect(sunday).toContain("1 PM");
    expect(sunday).toContain("October 2026");
  });

  it("offers the day, week, month and year views", () => {
    const html = renderToStaticMarkup(<ProjectCalendar projects={[]} initialDate="2026-10-07" />);
    for (const label of ["Tag", "Woche", "Monat", "Jahr", "Heute", "Zurück", "Weiter"]) {
      expect(html).toContain(label);
    }
  });

  it("keeps projects with no regular meeting visible and does not manufacture appointments", () => {
    const html = renderToStaticMarkup(
      <ProjectCalendar initialDate="2026-10-07" projects={[project("miltonticket.app")]} />,
    );
    expect(html).toContain('aria-label="Projekte ohne Regeltermin"');
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
      expect(html).toContain("Sitzung (running)");
      expect(html).toContain('aria-label="Kalenderprojekt"');
      expect(html).toContain("Alle Projekte");
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
    expect(html).toContain("Sitzungen nicht erreichbar · Anzeige evtl. veraltet");
  });
});
