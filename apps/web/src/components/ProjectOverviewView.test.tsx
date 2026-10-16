import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ThreadId } from "@workjet/contracts";
import { ProjectOverviewView, jourFixeJoinLocked, silentRetryDelayMs } from "./ProjectOverviewView";
import { buildProjectOwnerOverview, projectOverviewNextMeetingDate } from "../projectOverviewModel";
import { overviewFixture } from "../fixtures/project-overview.fixture-data";
import { disruptionContent } from "../projectFeedContent";
import { recordWorkerErrors, resetWorkerErrorLog, workerErrorLogSnapshot } from "../workerErrorLog";

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
  it("shows one compact line and no button before the meeting", () => {
    // Fixture-Regeltermin: Mittwoch 13:00; Stand: Montag 12:30 Berlin.
    const html = render(mondayBefore);
    expect(html).not.toContain('data-workjet-action="project.jour-fixe.open"');
    expect(html).not.toContain("Regeltermin beitreten");
    expect(html.replace(/<[^>]+>/g, "")).toContain("Nächster Regeltermin · Mi 13:00");
    expect(html).not.toContain(">13:00</button");
  });
  it("names the meeting timezone only when it differs from the local one", () => {
    const html = render(mondayBefore);
    const local = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (local === "Europe/Berlin") expect(html).not.toContain("Europe/Berlin");
    else expect(html).toContain(" · Europe/Berlin");
  });
  it("offers the join action inside the window", () => {
    // Mittwoch, 14.10.2026, 10:56 UTC = 12:56 Berlin: vier Minuten vor Beginn.
    const html = render(Date.parse("2026-10-14T10:56:00Z"));
    expect(html).toContain("Regeltermin beitreten");
  });
});

describe("ProjectOverviewView feed without filler (#711, #703, #586)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const fixtureNow = Date.parse("2026-10-15T10:00:00Z");
  const renderFull = (
    options: { lastError?: string; connectionError?: boolean; duplicate?: boolean } = {},
  ) => {
    vi.useFakeTimers();
    vi.setSystemTime(fixtureNow);
    const input = overviewFixture("full");
    let threads = input.threads.map((thread) =>
      options.lastError && thread.session?.status === "error"
        ? { ...thread, session: { ...thread.session, lastError: options.lastError } }
        : thread,
    );
    if (options.duplicate) {
      const disrupted = threads.find((thread) => thread.session?.status === "error")!;
      threads = [...threads, { ...disrupted, id: ThreadId.make("pinball-2") }];
    }
    const data = buildProjectOwnerOverview({ ...input, threads, language: "de", now: fixtureNow });
    return renderToStaticMarkup(
      <ProjectOverviewView
        data={data}
        onOpenChat={() => {}}
        onOpenJourFixe={() => {}}
        connectionError={options.connectionError ?? false}
        connectionMessage="Core veraltet · aktuellen CTOX-Core auf der Instanz anwenden"
        onRecomputeKpis={() => {}}
      />,
    );
  };
  const visibleText = (html: string) =>
    html
      .replace(/<details[\s\S]*?<\/details>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");

  it("renders no filler sentence or explainer card", () => {
    const html = renderFull();
    for (const filler of [
      "Eine Zusammenfassung schreibt der Supervisor",
      "liegt noch nicht vor",
      "Der Supervisor berichtet im Regeltermin",
      "Kennzahlen sind noch nicht berechnet",
      "Gerade läuft nichts",
    ])
      expect(html).not.toContain(filler);
    // Goals live once, in the side column; the feed has no empty "Ziel" cards.
    expect(html).not.toContain('data-workjet-feed-item="goal:');
    expect(html.match(/data-workjet-overview-goal=""/g)?.length).toBe(
      new Set(
        buildProjectOwnerOverview({
          ...overviewFixture("full"),
          language: "de",
          now: fixtureNow,
        }).goals.map((goal) => goal.title),
      ).size,
    );
  });
  it("shows the filters once, without counters", () => {
    const html = renderFull();
    expect(html).not.toContain('data-workjet-overview-column="views"');
    expect(html.match(/role="tab"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain(">Gemerkt<");
  });
  it("keeps a read error silent: no status sentence under the title", () => {
    const html = renderFull({ connectionError: true });
    expect(html).not.toContain("Projektdaten nicht geladen");
    expect(html).not.toContain("Core veraltet");
    expect(html).not.toContain("Erneut öffnen");
    expect(html).not.toContain('role="status"');
  });
  it("shows only the plain line with one button; the raw error goes to Diagnose", () => {
    for (const raw of ["Not logged in · Please run /login", "Build failed"]) {
      const html = renderFull({ lastError: raw });
      expect(html).not.toContain(raw);
      expect(html).not.toContain("<details");
      expect(html).not.toContain("data-workjet-feed-details");
      expect(visibleText(html)).not.toContain("Details");
      const content = disruptionContent({ name: "Pinball", lastError: raw, language: "de" });
      expect(content.details).toBe(raw);
      expect(content.body).not.toContain(raw);
    }
    const login = renderFull({ lastError: "Not logged in · Please run /login" });
    expect(login).toMatch(/<button[^>]*data-slot="button"[^>]*>[\s\S]{0,400}Im Chat anmelden/);
  });
  it("keeps the raw worker errors as a bounded newest-first list for Diagnose", () => {
    resetWorkerErrorLog();
    recordWorkerErrors([
      { key: "a", worker: "Pinball", raw: "Build failed", at: "2026-10-15T09:00:00Z" },
      { key: "b", worker: "Pinball", raw: "ENOENT", at: "2026-10-15T09:30:00Z" },
    ]);
    recordWorkerErrors([
      { key: "a", worker: "Pinball", raw: "Build failed", at: "2026-10-15T09:00:00Z" },
    ]);
    expect(workerErrorLogSnapshot().map((entry) => entry.raw)).toEqual(["ENOENT", "Build failed"]);
    recordWorkerErrors(
      Array.from({ length: 30 }, (_, index) => ({
        key: `k${index}`,
        worker: "W",
        raw: `e${index}`,
        at: new Date(Date.parse("2026-10-15T10:00:00Z") + index * 1000).toISOString(),
      })),
    );
    expect(workerErrorLogSnapshot()).toHaveLength(20);
    expect(workerErrorLogSnapshot()[0]!.raw).toBe("e29");
    resetWorkerErrorLog();
  });
  it("folds the same error of the same worker into one card", () => {
    const html = renderFull({ duplicate: true });
    expect(html.match(/data-workjet-feed-item="disruption:/g)?.length).toBe(1);
  });
  it("silent retry backs off and is capped", () => {
    expect(silentRetryDelayMs(0)).toBe(15_000);
    expect(silentRetryDelayMs(2)).toBe(60_000);
    expect(silentRetryDelayMs(10)).toBe(300_000);
  });
});
