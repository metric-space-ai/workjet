import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRightIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { GalleryProject } from "../projectOverview";
import type { CtoxWorkjetSessionProjection, WorkjetCalendarEvent } from "@workjet/contracts";
import {
  addDays,
  addMonths,
  formatDateKey,
  isSameMonth,
  localTimeZone,
  monthGrid,
  startOfMonth,
  startOfWeek,
  startOfYear,
  weeklyOccurrences,
  zonedReading,
  instantOf,
  type DateKey,
} from "../calendar/calendarDates";
import { Button } from "./ui/button";

export type CalendarView = "day" | "week" | "month" | "year";

export type AccountCalendarState = {
  readonly id: string; readonly label: string;
  readonly status: "loading" | "ready" | "unavailable" | "unsupported";
  readonly truncated: boolean; readonly syncedAtMs: number | null;
};

type CalendarProject = GalleryProject & {
  readonly onOpen: () => void;
  readonly onOpenJourFixe?: (() => void) | undefined;
};

/** One calendar event as the grid draws it. Times are instants; placement uses the display zone. */
type CalendarEvent = {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly date: DateKey;
  readonly minutes: number;
  readonly timeZone: string;
  readonly projectKey: string;
  readonly allDay?: boolean;
  readonly point?: boolean;
  readonly onOpen: () => void;
};

const PROJECT_CALENDAR_ID = "project-meetings";
const SESSION_CALENDAR_ID = "project-sessions";
/** Regular meetings carry no duration, so every one is drawn as an hour. */
const MEETING_MINUTES = 60;
const HOUR_HEIGHT = 48;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const VIEWS: readonly { readonly value: CalendarView; readonly label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];
const WEEKDAY_OFFSETS = Array.from({ length: 7 }, (_, index) => index);

function visibleRange(view: CalendarView, anchor: DateKey): { from: DateKey; to: DateKey } {
  switch (view) {
    case "day":
      return { from: anchor, to: anchor };
    case "week": {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 6) };
    }
    case "month": {
      const grid = monthGrid(anchor);
      return { from: grid[0] ?? anchor, to: grid[grid.length - 1] ?? anchor };
    }
    case "year":
      return { from: startOfYear(anchor), to: `${anchor.slice(0, 4)}-12-31` };
  }
}

function shiftAnchor(view: CalendarView, anchor: DateKey, direction: 1 | -1): DateKey {
  switch (view) {
    case "day":
      return addDays(anchor, direction);
    case "week":
      return addDays(anchor, 7 * direction);
    case "month":
      return addMonths(anchor, direction);
    case "year":
      return addMonths(anchor, 12 * direction);
  }
}

function rangeTitle(view: CalendarView, anchor: DateKey): string {
  switch (view) {
    case "day":
      return formatDateKey(anchor, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    case "week": {
      const from = startOfWeek(anchor);
      const to = addDays(from, 6);
      return `${formatDateKey(from, { month: "short", day: "numeric" })} – ${formatDateKey(to, { month: "short", day: "numeric", year: "numeric" })}`;
    }
    case "month":
      return formatDateKey(anchor, { month: "long", year: "numeric" });
    case "year":
      return anchor.slice(0, 4);
  }
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ms);
}

function formatHour(hour: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2000, 0, 1, hour));
}

export function buildEvents(
  projects: readonly CalendarProject[],
  from: DateKey,
  to: DateKey,
  displayZone: string,
): readonly CalendarEvent[] {
  return projects
    .flatMap((project) => {
      const meeting = project.configuration?.jourFixe;
      if (meeting == null) return [];
      return weeklyOccurrences(meeting, from, to, displayZone).map(
        (occurrence): CalendarEvent => ({
          id: `${project.key}:${occurrence.startMs}`,
          calendarId: PROJECT_CALENDAR_ID,
          title: project.title,
          startMs: occurrence.startMs,
          endMs: occurrence.startMs + MEETING_MINUTES * 60_000,
          date: occurrence.date,
          minutes: occurrence.minutes,
          timeZone: meeting.timezone,
          projectKey: project.key,
          onOpen: project.onOpenJourFixe ?? project.onOpen,
        }),
      );
    })
    .toSorted((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title));
}

export function buildSessionEvents(
  projects: readonly CalendarProject[],
  sessions: readonly CtoxWorkjetSessionProjection[],
  displayZone: string,
): readonly CalendarEvent[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return sessions.flatMap((session): CalendarEvent[] => {
    const project = byId.get(session.projectId);
    // Older native projections carry no start timestamp. Their update time
    // must never be represented as a session start or fabricated duration.
    if (project === undefined || session.createdAtMs === undefined) return [];
    const local = zonedReading(session.createdAtMs, displayZone);
    return [{
      id: `session:${session.id}`,
      calendarId: SESSION_CALENDAR_ID,
      title: `${project.title} · Session (${session.runStatus})`,
      startMs: session.createdAtMs,
      endMs: session.createdAtMs,
      point: true,
      date: local.date,
      minutes: local.minutes,
      timeZone: displayZone,
      projectKey: project.key,
      onOpen: project.onOpen,
    }];
  });
}

/** Split a provider occurrence across displayed dates; exclusive midnight ends
 * stay on the previous date. IDs retain occurrence identity plus date. */
export function buildAccountEvents(
  events: readonly WorkjetCalendarEvent[], from: DateKey, to: DateKey,
  displayZone: string, onOpen: (event: WorkjetCalendarEvent) => void,
  projects: readonly CalendarProject[] = [],
): readonly CalendarEvent[] {
  const projectKeys = new Map(projects.map((project) => [project.id, project.key]));
  return events.flatMap((event) => {
    // All-day dates belong to the account calendar, rather than moving to the
    // previous/next day when the viewer changes time zone.
    const eventZone = event.all_day ? event.timezone : displayZone;
    const first = zonedReading(event.start_ms, eventZone).date;
    const last = zonedReading(event.end_ms - 1, eventZone).date;
    const rows: CalendarEvent[] = [];
    for (let date = first < from ? from : first; date <= last && date <= to; date = addDays(date, 1)) {
      const startMs = Math.max(event.start_ms, instantOf(date, 0, eventZone));
      const endMs = Math.min(event.end_ms, instantOf(addDays(date, 1), 0, eventZone));
      rows.push({ id: `${event.id}:${date}`, calendarId: event.calendar_id, title: event.title,
        startMs, endMs, date, minutes: zonedReading(startMs, eventZone).minutes,
        allDay: event.all_day, timeZone: eventZone, projectKey: projectKeys.get(event.project_id ?? "") ?? "",
        onOpen: () => onOpen(event) });
    }
    return rows;
  });
}

function groupByDate(
  events: readonly CalendarEvent[],
): ReadonlyMap<DateKey, readonly CalendarEvent[]> {
  const groups = new Map<DateKey, CalendarEvent[]>();
  for (const event of events) {
    const group = groups.get(event.date);
    if (group) group.push(event);
    else groups.set(event.date, [event]);
  }
  return groups;
}

function EventButton({
  event,
  placement,
}: {
  readonly event: CalendarEvent;
  readonly placement: "block" | "chip";
}) {
  const label = `${event.title}, ${event.allDay ? "all-day" : formatTime(event.startMs)}`;
  if (placement === "chip") {
    return (
      <button
        type="button"
        onClick={event.onOpen}
        title={`${event.title} · ${event.timeZone}`}
        aria-label={label}
        data-workjet-action={`project.open.calendar:${event.projectKey}`}
        className="block w-full truncate rounded-sm bg-primary/12 px-1.5 py-0.5 text-left text-xs text-foreground transition-colors hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {event.allDay ? "" : formatTime(event.startMs)} {event.title}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={event.onOpen}
      title={`${event.title} · ${event.timeZone}`}
      aria-label={label}
      data-workjet-action={`project.open.calendar:${event.projectKey}`}
      className="absolute inset-x-0.5 overflow-hidden rounded-md border border-primary/30 bg-primary/12 px-2 py-1 text-left text-xs transition-colors hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring"
      style={{
        top: (event.minutes / 60) * HOUR_HEIGHT + 1,
        height: Math.max(Math.min((event.endMs - event.startMs) / 3_600_000 * HOUR_HEIGHT - 2,
          (1440 - event.minutes) / 60 * HOUR_HEIGHT - 2), 20),
      }}
    >
      <span className="block font-medium tabular-nums">{formatTime(event.startMs)}</span>
      <span className="block truncate">{event.title}</span>
    </button>
  );
}

function MiniMonth({
  monthKey,
  today,
  anchor,
  eventDates,
  onSelect,
}: {
  readonly monthKey: DateKey;
  readonly today: DateKey;
  readonly anchor: DateKey;
  readonly eventDates: ReadonlySet<DateKey>;
  readonly onSelect: (date: DateKey) => void;
}) {
  const title = formatDateKey(monthKey, { month: "long", year: "numeric" });
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-[11px] text-muted-foreground">
        {WEEKDAY_OFFSETS.map((index) => (
          <span key={index} className="py-0.5">
            {formatDateKey(addDays(startOfWeek(monthKey), index), { weekday: "narrow" })}
          </span>
        ))}
        {monthGrid(monthKey).map((date) => {
          const inMonth = isSameMonth(date, monthKey);
          const isToday = date === today;
          const isSelected = date === anchor;
          return (
            <button
              key={date}
              type="button"
              onClick={() => onSelect(date)}
              aria-label={formatDateKey(date, {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
              aria-pressed={isSelected}
              className={[
                "relative mx-auto flex size-7 items-center justify-center rounded-full text-xs tabular-nums transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
                inMonth ? "text-foreground" : "text-muted-foreground/50",
                isToday
                  ? "bg-primary font-semibold text-primary-foreground hover:bg-primary/90"
                  : "",
                isSelected && !isToday ? "ring-1 ring-primary" : "",
              ].join(" ")}
            >
              {Number(date.slice(8))}
              {eventDates.has(date) && !isToday ? (
                <span className="absolute bottom-0.5 size-1 rounded-full bg-primary" aria-hidden />
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function TimeGrid({
  days,
  eventsByDate,
  today,
  nowMinutes,
}: {
  readonly days: readonly DateKey[];
  readonly eventsByDate: ReadonlyMap<DateKey, readonly CalendarEvent[]>;
  readonly today: DateKey;
  readonly nowMinutes: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Open the grid at 07:00 so mornings are visible without scrolling.
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_HEIGHT;
  }, []);
  const columns = `3.5rem repeat(${days.length}, minmax(0, 1fr))`;
  return (
    <div className="min-w-0 overflow-x-auto rounded-md border border-border">
      <div className="flex flex-col" style={{ minWidth: days.length > 1 ? 700 : 0 }}>
      <div className="grid border-b border-border" style={{ gridTemplateColumns: columns }}>
        <span aria-hidden />
        {days.map((date) => {
          const isToday = date === today;
          return (
            <div key={date} className="flex flex-col items-center py-2 text-xs">
              <span className="text-muted-foreground">
                {formatDateKey(date, { weekday: "short" })}
              </span>
              <span
                className={[
                  "mt-0.5 flex size-7 items-center justify-center rounded-full text-sm tabular-nums",
                  isToday ? "bg-primary font-semibold text-primary-foreground" : "",
                ].join(" ")}
              >
                {Number(date.slice(8))}
              </span>
            </div>
          );
        })}
      </div>
      <div
        className="grid border-b border-border py-1 text-xs"
        style={{ gridTemplateColumns: columns }}
        aria-label="All-day events"
      >
        <span className="px-1 text-right text-muted-foreground">all-day</span>
        {days.map((date) => (
          <div
            key={date}
            className="min-h-6 border-l border-border px-0.5"
            data-calendar-allday={date}
          >
            {(eventsByDate.get(date) ?? []).filter((event) => event.allDay).map((event) =>
              <EventButton key={event.id} event={event} placement="chip" />)}
          </div>
        ))}
      </div>
      <div ref={scrollRef} className="relative h-[min(70vh,44rem)] overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: columns, height: HOUR_HEIGHT * 24 }}>
          <div className="relative text-right text-xs text-muted-foreground">
            {HOURS.map((hour) => (
              <span
                key={hour}
                className="absolute right-1.5 -translate-y-1/2 tabular-nums"
                style={{ top: hour * HOUR_HEIGHT }}
              >
                {hour === 0 ? "" : formatHour(hour)}
              </span>
            ))}
          </div>
          {days.map((date) => (
            <div key={date} className="relative border-l border-border" data-calendar-day={date}>
              {HOURS.map((hour) => (
                <div
                  key={hour}
                  className="absolute inset-x-0 border-t border-border/70"
                  style={{ top: hour * HOUR_HEIGHT }}
                />
              ))}
              {(eventsByDate.get(date) ?? []).filter((event) => !event.allDay).map((event) => (
                <EventButton key={event.id} event={event} placement="block" />
              ))}
              {date === today ? (
                <div
                  className="absolute inset-x-0 z-10 h-px bg-primary"
                  style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                  aria-hidden
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
  );
}

function MonthGrid({
  anchor,
  eventsByDate,
  today,
  onOpenDay,
}: {
  readonly anchor: DateKey;
  readonly eventsByDate: ReadonlyMap<DateKey, readonly CalendarEvent[]>;
  readonly today: DateKey;
  readonly onOpenDay: (date: DateKey) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="grid grid-cols-7 border-b border-border text-xs text-muted-foreground">
        {WEEKDAY_OFFSETS.map((index) => (
          <span key={index} className="px-2 py-1.5">
            {formatDateKey(addDays(startOfWeek(anchor), index), { weekday: "short" })}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {monthGrid(anchor).map((date) => {
          const dayEvents = eventsByDate.get(date) ?? [];
          const inMonth = isSameMonth(date, anchor);
          const isToday = date === today;
          return (
            <div
              key={date}
              className="flex min-h-24 min-w-0 flex-col gap-1 border-b border-l border-border p-1"
              data-calendar-day={date}
            >
              <button
                type="button"
                onClick={() => onOpenDay(date)}
                aria-label={formatDateKey(date, { weekday: "long", day: "numeric", month: "long" })}
                className={[
                  "self-start rounded-full px-1.5 text-xs tabular-nums hover:bg-accent",
                  inMonth ? "text-foreground" : "text-muted-foreground/50",
                  isToday
                    ? "bg-primary font-semibold text-primary-foreground hover:bg-primary/90"
                    : "",
                ].join(" ")}
              >
                {Number(date.slice(8))}
              </button>
              {dayEvents.slice(0, 3).map((event) => (
                <EventButton key={event.id} event={event} placement="chip" />
              ))}
              {dayEvents.length > 3 ? (
                <button
                  type="button"
                  onClick={() => onOpenDay(date)}
                  className="px-1 text-left text-xs text-muted-foreground hover:text-foreground"
                >
                  {dayEvents.length - 3} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ProjectCalendar({
  projects,
  initialDate,
  initialView = "week",
  sessions = [],
  sessionsStatus,
  onRefreshSessions,
  accountEvents = [], accountCalendars = [], accountsUnavailable = false,
  accountsLoading = false, accountsTruncated = false, onRefreshAccounts, onWindowChanged,
}: {
  readonly initialView?: CalendarView;
  readonly sessions?: readonly CtoxWorkjetSessionProjection[];
  readonly sessionsStatus?: "loading" | "ready" | "unavailable";
  readonly onRefreshSessions?: () => void;
  readonly accountEvents?: readonly WorkjetCalendarEvent[];
  readonly accountCalendars?: readonly AccountCalendarState[];
  readonly accountsUnavailable?: boolean;
  readonly accountsLoading?: boolean;
  readonly accountsTruncated?: boolean;
  readonly onRefreshAccounts?: () => void;
  readonly onWindowChanged?: (from: DateKey, to: DateKey) => void;
  readonly projects: readonly CalendarProject[];
  /** Anchor date (YYYY-MM-DD) shown at first render; defaults to today. */
  readonly initialDate?: DateKey;
}) {
  const displayZone = useMemo(() => localTimeZone(), []);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Minute resolution is enough for the now line; a faster tick would repaint for nothing.
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const current = zonedReading(now, displayZone);
  const today = current.date;

  const [selectedEvent, setSelectedEvent] = useState<WorkjetCalendarEvent | null>(null);
  const [view, setView] = useState<CalendarView>(initialView);
  const [projectKey, setProjectKey] = useState("all");
  const [anchor, setAnchor] = useState<DateKey>(() => initialDate ?? today);
  const [hiddenCalendars, setHiddenCalendars] = useState<ReadonlySet<string>>(() => new Set());

  const range = visibleRange(view, anchor);
  // Mini months draw event dots for the whole month grid, so the event window spans it too.
  const grid = monthGrid(anchor);
  const windowFrom = range.from < grid[0]! ? range.from : grid[0]!;
  const windowTo = range.to > grid[41]! ? range.to : grid[41]!;
  useEffect(() => { onWindowChanged?.(windowFrom, windowTo); }, [windowFrom, windowTo, onWindowChanged]);

  const allEvents = useMemo(
    () => [...buildEvents(projects, windowFrom, windowTo, displayZone),
      ...buildSessionEvents(projects, sessions, displayZone)
        .filter((event) => event.date >= windowFrom && event.date <= windowTo),
      ...buildAccountEvents(accountEvents, windowFrom, windowTo, displayZone, setSelectedEvent, projects)],
    [projects, sessions, accountEvents, windowFrom, windowTo, displayZone],
  );
  const visibleEvents = useMemo(
    () => allEvents.filter((event) => !hiddenCalendars.has(event.calendarId)
      && (projectKey === "all" || event.projectKey === projectKey)),
    [allEvents, hiddenCalendars, projectKey],
  );
  const eventsByDate = useMemo(() => groupByDate(visibleEvents), [visibleEvents]);
  const eventDates = useMemo(
    () => new Set(visibleEvents.map((event) => event.date)),
    [visibleEvents],
  );

  const unscheduled = projects.filter((project) => project.configuration?.jourFixe == null);
  const columnDays =
    view === "week" ? WEEKDAY_OFFSETS.map((index) => addDays(range.from, index)) : [anchor];

  return (
    <section
      aria-label="Project calendar"
      data-workjet-project-calendar=""
      className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]"
    >
      <aside className="order-2 space-y-6 lg:order-1">
        <label className="block text-sm">
          Project
          <select aria-label="Calendar project" value={projectKey} onChange={(event) => setProjectKey(event.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-2">
            <option value="all">All projects</option>
            {projects.map((project) => <option key={project.key} value={project.key}>{project.title}</option>)}
          </select>
        </label>
        <MiniMonth
          monthKey={startOfMonth(anchor)}
          today={today}
          anchor={anchor}
          eventDates={eventDates}
          onSelect={setAnchor}
        />
        <section aria-label="Calendars">
          <h2 className="mb-2 text-sm font-medium">Calendars</h2>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={!hiddenCalendars.has(PROJECT_CALENDAR_ID)}
              onChange={(event) => {
                setHiddenCalendars((previous) => {
                  const next = new Set(previous);
                  if (event.target.checked) next.delete(PROJECT_CALENDAR_ID);
                  else next.add(PROJECT_CALENDAR_ID);
                  return next;
                });
              }}
            />
            <span className="size-2.5 shrink-0 rounded-full bg-primary" aria-hidden />
            <span className="min-w-0 break-words">Project meetings</span>
          </label>
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary"
              checked={!hiddenCalendars.has(SESSION_CALENDAR_ID)}
              onChange={(event) => setHiddenCalendars((previous) => {
                const next = new Set(previous);
                if (event.target.checked) next.delete(SESSION_CALENDAR_ID); else next.add(SESSION_CALENDAR_ID);
                return next;
              })} />
            Project sessions
          </label>
          {sessionsStatus !== undefined && sessionsStatus !== "ready" &&
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {sessionsStatus === "loading" ? "Loading sessions…" : "Sessions unavailable. Previously loaded sessions may be out of date."}
            </p>}
          {sessions.some((session) => session.createdAtMs === undefined) &&
            <p role="status" className="mt-2 text-xs text-muted-foreground">Some sessions have no recorded start time.</p>}
          {onRefreshSessions && <Button size="sm" variant="ghost" disabled={sessionsStatus === "loading"}
            onClick={onRefreshSessions}>Refresh sessions</Button>}
          <h3 className="mt-4 text-sm font-medium">Connected accounts</h3>
          {accountsLoading && <p role="status" className="text-xs text-muted-foreground">Loading calendar accounts…</p>}
          {accountsUnavailable && <p role="status" className="text-xs text-muted-foreground">Account calendars unavailable.</p>}
          {!accountsLoading && !accountsUnavailable && accountCalendars.length === 0 &&
            <p className="text-xs text-muted-foreground">No calendar accounts connected to this instance.</p>}
          {accountCalendars.map((calendar) => <div key={calendar.id} className="mt-2 text-xs">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!hiddenCalendars.has(calendar.id)}
                onChange={(event) => setHiddenCalendars((previous) => {
                  const next = new Set(previous);
                  if (event.target.checked) next.delete(calendar.id); else next.add(calendar.id);
                  return next;
                })} />
              <span className="min-w-0 break-words">{calendar.label}</span>
            </label>
            <p role="status" className="ml-6 text-muted-foreground">
              {calendar.status === "ready" ? calendar.truncated ? "Partial sync · more events on the account" :
                calendar.syncedAtMs === null ? "Synced" : `Synced ${new Date(calendar.syncedAtMs).toLocaleTimeString()}` :
                calendar.status === "loading" ? "Syncing…" : calendar.status === "unsupported" ?
                "Calendar connection not supported for this account" : "Sync failed"}
            </p>
          </div>)}
          {accountsTruncated && <p role="status" className="text-xs text-muted-foreground">The account list is incomplete.</p>}
          {onRefreshAccounts && <Button size="sm" variant="ghost" onClick={onRefreshAccounts}>Sync accounts</Button>}
        </section>
        {unscheduled.length > 0 && (
          <section aria-label="Projects without a regular meeting">
            <h2 className="text-sm font-medium">No regular meeting</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Set a project's regular meeting in its settings.
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {unscheduled.map((project) => (
                <Button
                  key={project.key}
                  size="sm"
                  variant="ghost"
                  onClick={project.onOpen}
                  data-workjet-action={`project.open.calendar:${project.key}`}
                >
                  {project.title}
                  <ArrowUpRightIcon className="size-3" />
                </Button>
              ))}
            </div>
          </section>
        )}
      </aside>
      <div className="order-1 min-w-0 lg:order-2">
        {selectedEvent !== null && <section role="dialog" aria-label="Calendar event details" className="mb-4 rounded-md border border-border p-4">
          <div className="flex items-start justify-between gap-2">
            <h2 className="font-semibold">{selectedEvent.title}</h2>
            <Button size="sm" variant="ghost" onClick={() => setSelectedEvent(null)}>Close</Button>
          </div>
          <p className="mt-2 text-sm">{new Date(selectedEvent.start_ms).toLocaleString()} – {new Date(selectedEvent.end_ms).toLocaleString()}</p>
          {selectedEvent.location && <p className="mt-2 text-sm">{selectedEvent.location}</p>}
          {selectedEvent.notes && <p className="mt-2 whitespace-pre-wrap text-sm">{selectedEvent.notes}</p>}
          <p className="mt-2 text-xs text-muted-foreground">Synced account event · read only</p>
        </section>}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setAnchor(today)}>
            Today
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Previous"
            onClick={() => setAnchor((previous) => shiftAnchor(view, previous, -1))}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Next"
            onClick={() => setAnchor((previous) => shiftAnchor(view, previous, 1))}
          >
            <ChevronRightIcon />
          </Button>
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold" aria-live="polite">
            {rangeTitle(view, anchor)}
          </h2>
          <div
            role="group"
            aria-label="Calendar view"
            className="inline-flex gap-1 rounded-md border border-border p-1"
          >
            {VIEWS.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={view === option.value ? "secondary" : "ghost"}
                aria-pressed={view === option.value}
                onClick={() => setView(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
        {view === "month" ? (
          <MonthGrid
            anchor={anchor}
            eventsByDate={eventsByDate}
            today={today}
            onOpenDay={(date) => {
              setAnchor(date);
              setView("day");
            }}
          />
        ) : view === "year" ? (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 12 }, (_, index) => (
              <MiniMonth
                key={index}
                monthKey={`${anchor.slice(0, 4)}-${String(index + 1).padStart(2, "0")}-01`}
                today={today}
                anchor={anchor}
                eventDates={eventDates}
                onSelect={(date) => {
                  setAnchor(startOfMonth(date));
                  setView("month");
                }}
              />
            ))}
          </div>
        ) : (
          <TimeGrid
            days={columnDays}
            eventsByDate={eventsByDate}
            today={today}
            nowMinutes={current.minutes}
          />
        )}
      </div>
    </section>
  );
}
