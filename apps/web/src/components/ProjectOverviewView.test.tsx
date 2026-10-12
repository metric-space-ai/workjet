import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ProjectOverviewView, jourFixeJoinLocked } from "./ProjectOverviewView";
import { buildProjectOwnerOverview, projectOverviewNextMeetingDate } from "../projectOverviewModel";
import { overviewFixture } from "../fixtures/project-overview.fixture-data";

const recurring = { weekday: 1, time: "13:00", timezone: "Europe/Berlin" };
// Montag, 12.10.2026: 10:30 UTC = 12:30 in Berlin (Sommerzeit).
const mondayBefore = Date.parse("2026-10-12T10:30:00Z");
const mondayLead = Date.parse("2026-10-12T10:56:00Z");
const mondayDuring = Date.parse("2026-10-12T12:30:00Z");
const tuesday = Date.parse("2026-10-13T10:30:00Z");

describe("jourFixeJoinLocked", () => {
  const next = (now: number) => projectOverviewNextMeetingDate(recurring, now);
  it("locks the button more than five minutes before the meeting", () => {
    expect(jourFixeJoinLocked(recurring, next(mondayBefore), mondayBefore)).toBe(true);
  });
  it("activates the button five minutes before the meeting", () => {
    expect(jourFixeJoinLocked(recurring, next(mondayLead), mondayLead)).toBe(false);
  });
  it("stays active for the rest of the meeting day", () => {
    expect(jourFixeJoinLocked(recurring, next(mondayDuring), mondayDuring)).toBe(false);
  });
  it("locks again for the next weekly occurrence", () => {
    expect(jourFixeJoinLocked(recurring, next(tuesday), tuesday)).toBe(true);
  });
  it("never locks projects without a configured meeting", () => {
    expect(jourFixeJoinLocked(null, null, mondayBefore)).toBe(false);
    expect(jourFixeJoinLocked(recurring, null, mondayBefore)).toBe(false);
  });
});

describe("ProjectOverviewView join button", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const render = (now: number) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const data = buildProjectOwnerOverview({
      ...overviewFixture("empty"),
      language: "de",
      now,
    });
    return renderToStaticMarkup(
      <ProjectOverviewView data={data} onOpenChat={() => {}} onOpenJourFixe={() => {}} />,
    );
  };
  it("shows only the time before the meeting", () => {
    // Fixture-Regeltermin: Mittwoch 13:00; Stand: Montag 12:30 Berlin.
    const html = render(mondayBefore);
    expect(html).toContain('data-workjet-action="project.jour-fixe.open"');
    expect(html).not.toContain("Regeltermin beitreten");
    expect(html).toContain(">13:00</");
  });
  it("offers the join action inside the window", () => {
    // Mittwoch, 14.10.2026, 10:56 UTC = 12:56 Berlin: vier Minuten vor Beginn.
    const html = render(Date.parse("2026-10-14T10:56:00Z"));
    expect(html).toContain("Regeltermin beitreten");
  });
});
