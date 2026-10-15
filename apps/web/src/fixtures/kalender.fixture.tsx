/**
 * Isolierte Fixture für den Projektkalender (Screenshots, kein Backend).
 * ?view=day|week|month|year wählt die Ansicht; ?pending=1 lässt Sitzungen und
 * Konten nie antworten, damit das Ende des Ladens nach 10 s sichtbar wird.
 */
import { ProjectId, type CtoxWorkjetSessionProjection } from "@workjet/contracts";
import type { WorkjetCalendarEvent } from "@workjet/contracts";
import { createRoot } from "react-dom/client";
import { ProjectCalendar, type CalendarView } from "../components/ProjectCalendar";
import type { GalleryProject } from "../projectOverview";
import "../index.css";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  throw new Error("Calendar fixture is available only on a loopback development server.");
}
document.documentElement.lang = "de";

const query = new URLSearchParams(window.location.search);
const view = (query.get("view") ?? "week") as CalendarView;
const pending = query.get("pending") === "1";

function project(
  id: string,
  title: string,
  jourFixe?: { weekday: number; time: string; timezone: string },
) {
  return {
    key: `fixture:${id}`,
    id,
    title,
    native: true,
    local: null,
    configuration: { id: ProjectId.make(id), title, ...(jourFixe ? { jourFixe } : {}) },
    onOpen: () => {},
  } as GalleryProject & { onOpen: () => void };
}

const projects = [
  project("ctox", "ctox.dev", { weekday: 3, time: "13:00", timezone: "Europe/Berlin" }),
  project("workjet", "Workjet", { weekday: 1, time: "09:30", timezone: "Europe/Berlin" }),
  project("greppy", "greppy.xyz", { weekday: 5, time: "16:00", timezone: "Europe/Berlin" }),
  project("thesen", "Thesen"),
];

const at = (iso: string) => Date.parse(iso);
const session = (
  id: string,
  projectId: string,
  start: string,
  runStatus: CtoxWorkjetSessionProjection["runStatus"],
): CtoxWorkjetSessionProjection =>
  ({
    id,
    projectId,
    workingCopyId: `${id}-copy`,
    computerId: "computer-1",
    threadId: null,
    codingSessionId: null,
    runStatus,
    fenceEpoch: 0,
    activeTransferId: null,
    createdAtMs: at(start),
    updatedAtMs: at(start),
  }) as CtoxWorkjetSessionProjection;

const sessions = [
  session("s1", "ctox", "2026-10-14T08:15:00+02:00", "running"),
  session("s2", "workjet", "2026-10-13T14:40:00+02:00", "paused"),
];

const accountEvent = (
  id: string,
  title: string,
  start: string,
  end: string,
  allDay = false,
): WorkjetCalendarEvent =>
  ({
    id,
    calendar_id: "account:michael",
    kind: "synced",
    title,
    start_ms: at(start),
    end_ms: at(end),
    all_day: allDay,
    timezone: "Europe/Berlin",
    revision: 1,
  }) as WorkjetCalendarEvent;

const accountEvents = [
  accountEvent("a1", "Kundentermin SKF", "2026-10-14T10:00:00+02:00", "2026-10-14T11:30:00+02:00"),
  accountEvent("a2", "Steuerberater", "2026-10-15T15:00:00+02:00", "2026-10-15T16:00:00+02:00"),
  accountEvent("a3", "Messe", "2026-10-16T00:00:00+02:00", "2026-10-17T00:00:00+02:00", true),
  accountEvent("a4", "Release 0.1", "2026-10-22T11:00:00+02:00", "2026-10-22T12:00:00+02:00"),
];

createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-background p-4 text-foreground">
    <ProjectCalendar
      initialView={view}
      initialDate="2026-10-14"
      projects={projects}
      sessions={pending ? [] : sessions}
      sessionsStatus={pending ? "loading" : "ready"}
      onRefreshSessions={() => {}}
      accountEvents={pending ? [] : accountEvents}
      accountCalendars={[
        {
          id: "account:michael",
          label: "michael@welsch.one",
          status: pending ? "loading" : "ready",
          truncated: false,
          syncedAtMs: at("2026-10-14T13:05:00+02:00"),
        },
      ]}
      accountsLoading={pending}
      onRefreshAccounts={() => {}}
    />
  </div>,
);
