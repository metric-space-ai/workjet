import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectId } from "@workjet/contracts";
import { ProjectCalendar, buildSessionEvents } from "./ProjectCalendar";
import type { GalleryProject } from "../projectOverview";

// Diese Tests prüfen deutsche Texte und Datumsformate: Oberflächensprache
// fest auf "de", damit "System" nicht von der Testumgebung (englisch) abhängt.
vi.mock("../hooks/useProjectOverviewLanguage", () => ({
  useProjectOverviewLanguage: () => "de",
}));

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
        locale="de-DE"
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
    expect(html).toContain('title="greppy.xyz · America/New_York"');
  });

  it("speaks German dates and 24-hour times, and honours the week start", () => {
    const html = renderToStaticMarkup(
      <ProjectCalendar
        locale="de-DE"
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

  it("never shows English month, weekday or AM/PM names in German, in any view (#482)", () => {
    // Production path: no locale prop, an English OS/browser, UI language German.
    const originalLanguage = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language: "en-US", languages: ["en-US"] },
    });
    try {
      for (const initialView of ["day", "week", "month"] as const) {
        const html = renderToStaticMarkup(
          <ProjectCalendar
            initialView={initialView}
            initialDate="2026-10-14"
            projects={[project("ctox.dev", { weekday: 3, time: "13:00", timezone: "UTC" })]}
            accountEvents={[
              {
                id: "account-1",
                calendar_id: "account:1",
                title: "Regeltermin Vertrieb",
                start_ms: Date.parse("2026-10-14T11:00:00Z"),
                end_ms: Date.parse("2026-10-14T12:00:00Z"),
                all_day: false,
                timezone: "Europe/Berlin",
              } as never,
            ]}
          />,
        ).replace(/[\u2009\u202f]/g, " ");
        expect(html, initialView).not.toMatch(/\b(Oct|October|Mon|Monday|Wed|AM|PM)\b/);
        expect(html, initialView).toMatch(/Okt|Oktober/);
      }
      const week = renderToStaticMarkup(
        <ProjectCalendar
          initialView="week"
          initialDate="2026-10-14"
          projects={[project("ctox.dev", { weekday: 3, time: "13:00", timezone: "UTC" })]}
        />,
      ).replace(/[\u2009\u202f]/g, " ");
      // Week starts Monday, hours are 24-hour.
      expect(week).toContain("12.–18. Okt. 2026 · KW 42");
      expect(week).toContain("13:00");
      const monday = week.search(/>Mo\.?</);
      expect(monday).toBeGreaterThan(-1);
      expect(monday).toBeLessThan(week.search(/>So\.?</));
    } finally {
      if (originalLanguage) Object.defineProperty(globalThis, "navigator", originalLanguage);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });

  it("offers the day, week, month and year views", () => {
    const html = renderToStaticMarkup(
      <ProjectCalendar locale="de-DE" projects={[]} initialDate="2026-10-07" />,
    );
    for (const label of ["Tag", "Woche", "Monat", "Jahr", "Heute", "Zurück", "Weiter"]) {
      expect(html).toContain(label);
    }
  });

  it("renders calendar chrome in English for an English UI", () => {
    const html = renderToStaticMarkup(
      <ProjectCalendar
        locale="en-GB"
        projects={[project("miltonticket.app")]}
        initialDate="2026-10-07"
        initialView="day"
        sessionsStatus="loading"
        accountsLoading
        onRefreshSessions={() => {}}
      />,
    );
    for (const label of [
      "Day",
      "Week",
      "Month",
      "Year",
      "Today",
      'aria-label="Previous"',
      'aria-label="Next"',
      "Regular meetings",
      "Project sessions",
      "Refresh",
      "all-day",
      'aria-label="Projects without a regular meeting"',
      'aria-label="Calendar view"',
    ]) {
      expect(html).toContain(label);
    }
    for (const german of [
      "Heute",
      "ganztägig",
      "Regeltermine",
      "Projektsitzungen",
      "geladen",
      "Aktualisieren",
    ]) {
      expect(html).not.toContain(german);
    }
  });

  it("keeps projects with no regular meeting visible and does not manufacture appointments", () => {
    const html = renderToStaticMarkup(
      <ProjectCalendar
        locale="de-DE"
        initialDate="2026-10-07"
        projects={[project("miltonticket.app")]}
      />,
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
    // Run status is shown in the UI language, never as the raw contract value.
    expect(events[0]?.title).toBe("ctox.dev · Sitzung (läuft)");
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
          locale="de-DE"
          initialView={initialView}
          initialDate="2026-10-07"
          projects={[project("ctox.dev")]}
          sessions={[session]}
        />,
      );
      expect(html).toContain("Sitzung (läuft)");
      expect(html).not.toContain("(running)");
      expect(html).toContain('aria-label="Kalenderprojekt"');
      expect(html).toContain("Alle Projekte");
    });
  }
  it("marks retained data stale when the native read fails", () => {
    const html = renderToStaticMarkup(
      <ProjectCalendar
        locale="de-DE"
        projects={[project("ctox.dev")]}
        initialDate="2026-10-07"
        sessions={[session]}
        sessionsStatus="unavailable"
      />,
    );
    // A failed read is one status line plus a retry button, no explanation.
    expect(html).toContain('data-workjet-calendar-load="failed"');
    expect(html).toContain("Nicht geladen");
    expect(html).not.toContain("nicht erreichbar");
  });
});
