import { workjetUiLanguage } from "../workjetProjectControl";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Checkbox } from "./ui/checkbox";
import { OptionSelect } from "./ui/option-select";
import { ArrowUpRightIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { GalleryProject } from "../projectOverview";
import type { CtoxWorkjetSessionProjection, WorkjetCalendarEvent } from "@workjet/contracts";
import {
  addDays,
  addMonths,
  formatClockTime,
  formatDateKey,
  formatDateKeyRange,
  formatHourLabel,
  calendarLocale,
  formatDateTime,
  isoWeekNumber,
  isSameMonth,
  resolveWeekStart,
  localTimeZone,
  monthGrid,
  startOfMonth,
  startOfWeek,
  startOfYear,
  weeklyOccurrences,
  zonedReading,
  instantOf,
  type CalendarTimeFormat,
  type DateKey,
  type WeekStart,
} from "../calendar/calendarDates";
import { useClientSettings } from "../hooks/useSettings";
import { useProjectOverviewLanguage } from "../hooks/useProjectOverviewLanguage";
import { Button } from "./ui/button";
import { InlineExpand } from "./ui/inline-expand";

export type CalendarView = "day" | "week" | "month" | "year";

export type AccountCalendarState = {
  readonly id: string;
  readonly label: string;
  readonly status: "loading" | "ready" | "unavailable" | "unsupported";
  readonly truncated: boolean;
  readonly syncedAtMs: number | null;
};

/** Only exceptions earn a visible line; routine sync state stays in the tooltip. */
export function accountCalendarProblem(calendar: AccountCalendarState): string | null {
  if (calendar.status === "unavailable") return calText("Abgleich fehlgeschlagen", "Sync failed");
  if (calendar.status === "unsupported") return calText("Nicht unterstützt", "Not supported");
  if (calendar.status === "ready" && calendar.truncated)
    return calText("Teilweise abgeglichen", "Partially synced");
  return null;
}

export function accountCalendarStatusTitle(
  calendar: AccountCalendarState,
  timeFormat: CalendarTimeFormat = "locale",
  locale: string = "de-DE",
): string {
  if (calendar.status === "loading") return calText("Wird abgeglichen …", "Syncing …");
  if (calendar.status !== "ready") return accountCalendarProblem(calendar) ?? "";
  return calendar.syncedAtMs === null
    ? calText("Abgeglichen", "Synced")
    : `${calText("Abgeglichen", "Synced")} ${formatClockTime(calendar.syncedAtMs, timeFormat, undefined, locale)}`;
}

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
  { value: "day", label: "Tag" },
  { value: "week", label: "Woche" },
  { value: "month", label: "Monat" },
  { value: "year", label: "Jahr" },
];
const WEEKDAY_OFFSETS = Array.from({ length: 7 }, (_, index) => index);

type CalendarFormat = {
  readonly locale: string;
  readonly timeFormat: CalendarTimeFormat;
  readonly weekStart: WeekStart;
};
const CalendarFormatContext = createContext<CalendarFormat>({
  locale: "de-DE",
  timeFormat: "locale",
  weekStart: "monday",
});

/** Calendar week label per UI language; new languages add an entry. */
const VIEW_LABEL_EN: Record<string, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
};

function calText(de: string, en: string): string {
  return workjetUiLanguage() === "en" ? en : de;
}

const WEEK_NUMBER_LABEL: Record<string, string> = { de: "KW", en: "Week" };

function weekNumberLabel(locale: string, week: number): string {
  const language = locale.split("-")[0] ?? "de";
  return `${WEEK_NUMBER_LABEL[language] ?? WEEK_NUMBER_LABEL.en} ${week}`;
}

function visibleRange(
  view: CalendarView,
  anchor: DateKey,
  weekStart: WeekStart,
): { from: DateKey; to: DateKey } {
  switch (view) {
    case "day":
      return { from: anchor, to: anchor };
    case "week": {
      const from = startOfWeek(anchor, weekStart);
      return { from, to: addDays(from, 6) };
    }
    case "month": {
      const grid = monthGrid(anchor, weekStart);
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

function rangeTitle(view: CalendarView, anchor: DateKey, format: CalendarFormat): string {
  const { locale, weekStart } = format;
  switch (view) {
    case "day":
      return formatDateKey(
        anchor,
        {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        },
        locale,
      );
    case "week": {
      const from = startOfWeek(anchor, weekStart);
      const to = addDays(from, 6);
      // KW follows ISO 8601 and is read from the Monday of the shown week.
      return `${formatDateKeyRange(from, to, locale)} · ${weekNumberLabel(locale, isoWeekNumber(startOfWeek(anchor)))}`;
    }
    case "month":
      return formatDateKey(anchor, { month: "long", year: "numeric" }, locale);
    case "year":
      return anchor.slice(0, 4);
  }
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
    return [
      {
        id: `session:${session.id}`,
        calendarId: SESSION_CALENDAR_ID,
        title: `${project.title} · ${calText("Sitzung", "Session")} (${session.runStatus})`,
        startMs: session.createdAtMs,
        endMs: session.createdAtMs,
        point: true,
        date: local.date,
        minutes: local.minutes,
        timeZone: displayZone,
        projectKey: project.key,
        onOpen: project.onOpen,
      },
    ];
  });
}

/** Split a provider occurrence across displayed dates; exclusive midnight ends
 * stay on the previous date. IDs retain occurrence identity plus date. */
export function buildAccountEvents(
  events: readonly WorkjetCalendarEvent[],
  from: DateKey,
  to: DateKey,
  displayZone: string,
  onOpen: (event: WorkjetCalendarEvent) => void,
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
    for (
      let date = first < from ? from : first;
      date <= last && date <= to;
      date = addDays(date, 1)
    ) {
      const startMs = Math.max(event.start_ms, instantOf(date, 0, eventZone));
      const endMs = Math.min(event.end_ms, instantOf(addDays(date, 1), 0, eventZone));
      rows.push({
        id: `${event.id}:${date}`,
        calendarId: event.calendar_id,
        title: event.title,
        startMs,
        endMs,
        date,
        minutes: zonedReading(startMs, eventZone).minutes,
        allDay: event.all_day,
        timeZone: eventZone,
        projectKey: projectKeys.get(event.project_id ?? "") ?? "",
        onOpen: () => onOpen(event),
      });
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
  const { timeFormat, locale } = useContext(CalendarFormatContext);
  const formatTime = (ms: number) => formatClockTime(ms, timeFormat, undefined, locale);
  const label = `${event.title}, ${event.allDay ? calText("ganztägig", "all day") : formatTime(event.startMs)}`;
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
        height: Math.max(
          Math.min(
            ((event.endMs - event.startMs) / 3_600_000) * HOUR_HEIGHT - 2,
            ((1440 - event.minutes) / 60) * HOUR_HEIGHT - 2,
          ),
          20,
        ),
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
  const { weekStart, locale } = useContext(CalendarFormatContext);
  const title = formatDateKey(monthKey, { month: "long", year: "numeric" }, locale);
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-[11px] text-muted-foreground">
        {WEEKDAY_OFFSETS.map((index) => (
          <span key={index} className="py-0.5">
            {formatDateKey(
              addDays(startOfWeek(monthKey, weekStart), index),
              { weekday: "narrow" },
              locale,
            )}
          </span>
        ))}
        {monthGrid(monthKey, weekStart).map((date) => {
          const inMonth = isSameMonth(date, monthKey);
          const isToday = date === today;
          const isSelected = date === anchor;
          return (
            <button
              key={date}
              type="button"
              onClick={() => onSelect(date)}
              aria-label={formatDateKey(
                date,
                {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                },
                locale,
              )}
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
  const { timeFormat, locale } = useContext(CalendarFormatContext);
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
                  {formatDateKey(date, { weekday: "short" }, locale)}
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
          aria-label={calText("Ganztägige Termine", "All-day events")}
        >
          <span className="px-1 text-right text-muted-foreground">
            {calText("ganztägig", "all day")}
          </span>
          {days.map((date) => (
            <div
              key={date}
              className="min-h-6 border-l border-border px-0.5"
              data-calendar-allday={date}
            >
              {(eventsByDate.get(date) ?? [])
                .filter((event) => event.allDay)
                .map((event) => (
                  <EventButton key={event.id} event={event} placement="chip" />
                ))}
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
                  {hour === 0 ? "" : formatHourLabel(hour, timeFormat, locale)}
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
                {(eventsByDate.get(date) ?? [])
                  .filter((event) => !event.allDay)
                  .map((event) => (
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
  const { weekStart, locale } = useContext(CalendarFormatContext);
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="grid grid-cols-7 border-b border-border text-xs text-muted-foreground">
        {WEEKDAY_OFFSETS.map((index) => (
          <span key={index} className="px-2 py-1.5">
            {formatDateKey(
              addDays(startOfWeek(anchor, weekStart), index),
              { weekday: "short" },
              locale,
            )}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {monthGrid(anchor, weekStart).map((date) => {
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
                aria-label={formatDateKey(
                  date,
                  { weekday: "long", day: "numeric", month: "long" },
                  locale,
                )}
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
                  {dayEvents.length - 3} weitere
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
  accountEvents = [],
  accountCalendars = [],
  accountsUnavailable = false,
  accountsLoading = false,
  accountsTruncated = false,
  onRefreshAccounts,
  onWindowChanged,
  timeFormat: timeFormatOverride,
  weekStart: weekStartOverride,
  locale: localeOverride,
}: {
  /** Overrides the locale derived from the UI language; mainly for fixtures and tests. */
  readonly locale?: string;
  /** Overrides the Zeitformat setting; mainly for fixtures and tests. */
  readonly timeFormat?: CalendarTimeFormat;
  /** Overrides the Wochenbeginn setting; mainly for fixtures and tests. */
  readonly weekStart?: WeekStart | "locale";
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
  const settingsTimeFormat = useClientSettings((settings) => settings.timestampFormat);
  const settingsWeekStart = useClientSettings((settings) => settings.calendarWeekStart);
  const uiLanguage = useProjectOverviewLanguage();
  const locale =
    localeOverride ??
    calendarLocale(uiLanguage, typeof navigator === "undefined" ? undefined : navigator.language);
  const timeFormat = timeFormatOverride ?? settingsTimeFormat;
  const weekStart = resolveWeekStart(weekStartOverride ?? settingsWeekStart, locale);
  const format = useMemo(
    () => ({ locale, timeFormat, weekStart }),
    [locale, timeFormat, weekStart],
  );
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

  const range = visibleRange(view, anchor, weekStart);
  // Mini months draw event dots for the whole month grid, so the event window spans it too.
  const grid = monthGrid(anchor, weekStart);
  const windowFrom = range.from < grid[0]! ? range.from : grid[0]!;
  const windowTo = range.to > grid[41]! ? range.to : grid[41]!;
  useEffect(() => {
    onWindowChanged?.(windowFrom, windowTo);
  }, [windowFrom, windowTo, onWindowChanged]);

  const allEvents = useMemo(
    () => [
      ...buildEvents(projects, windowFrom, windowTo, displayZone),
      ...buildSessionEvents(projects, sessions, displayZone).filter(
        (event) => event.date >= windowFrom && event.date <= windowTo,
      ),
      ...buildAccountEvents(
        accountEvents,
        windowFrom,
        windowTo,
        displayZone,
        setSelectedEvent,
        projects,
      ),
    ],
    [projects, sessions, accountEvents, windowFrom, windowTo, displayZone],
  );
  const visibleEvents = useMemo(
    () =>
      allEvents.filter(
        (event) =>
          !hiddenCalendars.has(event.calendarId) &&
          (projectKey === "all" || event.projectKey === projectKey),
      ),
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
    <CalendarFormatContext.Provider value={format}>
      <section
        aria-label={calText("Projektkalender", "Project calendar")}
        data-workjet-project-calendar=""
        className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]"
      >
        <aside className="order-2 space-y-6 lg:order-1">
          <label className="block text-sm">
            {calText("Projekt", "Project")}
            <OptionSelect
              aria-label={calText("Kalenderprojekt", "Calendar project")}
              className="mt-1"
              size="default"
              value={projectKey}
              options={[
                { value: "all", label: calText("Alle Projekte", "All projects") },
                ...projects.map((project) => ({ value: project.key, label: project.title })),
              ]}
              onValueChange={setProjectKey}
            />
          </label>
          <MiniMonth
            monthKey={startOfMonth(anchor)}
            today={today}
            anchor={anchor}
            eventDates={eventDates}
            onSelect={setAnchor}
          />
          <section aria-label={calText("Kalender", "Calendars")}>
            <h2 className="mb-2 text-sm font-medium">{calText("Kalender", "Calendars")}</h2>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={!hiddenCalendars.has(PROJECT_CALENDAR_ID)}
                onCheckedChange={(checked) => {
                  setHiddenCalendars((previous) => {
                    const next = new Set(previous);
                    if (checked) next.delete(PROJECT_CALENDAR_ID);
                    else next.add(PROJECT_CALENDAR_ID);
                    return next;
                  });
                }}
              />
              <span className="size-2.5 shrink-0 rounded-full bg-primary" aria-hidden />
              <span className="min-w-0 break-words">
                {calText("Regeltermine", "Regular meetings")}
              </span>
            </label>
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={!hiddenCalendars.has(SESSION_CALENDAR_ID)}
                onCheckedChange={(checked) =>
                  setHiddenCalendars((previous) => {
                    const next = new Set(previous);
                    if (checked) next.delete(SESSION_CALENDAR_ID);
                    else next.add(SESSION_CALENDAR_ID);
                    return next;
                  })
                }
              />
              {calText("Projektsitzungen", "Project sessions")}
            </label>
            {sessionsStatus === "unavailable" && (
              <p role="status" className="mt-2 text-xs text-muted-foreground">
                {calText(
                  "Sitzungen nicht erreichbar · Anzeige evtl. veraltet",
                  "Sessions unreachable · may be out of date",
                )}
              </p>
            )}
            {accountCalendars.length > 0 && (
              <h3 className="mt-4 text-sm font-medium">
                {calText("Verbundene Konten", "Connected accounts")}
              </h3>
            )}
            {accountsUnavailable && (
              <p role="status" className="mt-2 text-xs text-muted-foreground">
                {calText("Kontokalender nicht erreichbar.", "Account calendars unreachable.")}
              </p>
            )}
            {accountCalendars.map((calendar) => {
              const problem = accountCalendarProblem(calendar);
              return (
                <div key={calendar.id} className="mt-2 text-sm">
                  <label
                    className="flex cursor-pointer items-center gap-2"
                    title={accountCalendarStatusTitle(calendar, timeFormat, locale)}
                  >
                    <Checkbox
                      checked={!hiddenCalendars.has(calendar.id)}
                      onCheckedChange={(checked) =>
                        setHiddenCalendars((previous) => {
                          const next = new Set(previous);
                          if (checked) next.delete(calendar.id);
                          else next.add(calendar.id);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0 break-words">{calendar.label}</span>
                  </label>
                  {problem !== null && (
                    <p role="status" className="ml-6 text-xs text-muted-foreground">
                      {problem}
                    </p>
                  )}
                </div>
              );
            })}
            {accountsTruncated && (
              <p role="status" className="mt-2 text-xs text-muted-foreground">
                {calText("Kontenliste unvollständig.", "Account list incomplete.")}
              </p>
            )}
            {(onRefreshSessions || onRefreshAccounts) && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={sessionsStatus === "loading" || accountsLoading}
                onClick={() => {
                  onRefreshSessions?.();
                  onRefreshAccounts?.();
                }}
              >
                {calText("Aktualisieren", "Refresh")}
              </Button>
            )}
          </section>
          {unscheduled.length > 0 && (
            <section
              aria-label={calText(
                "Projekte ohne Regeltermin",
                "Projects without a regular meeting",
              )}
            >
              <h2 className="text-sm font-medium">
                {calText("Ohne Regeltermin", "Without regular meeting")}
              </h2>
              {/* Real buttons, not caption-like text (#595): each opens the project to set its meeting. */}
              <div className="mt-2 flex flex-wrap gap-1">
                {unscheduled.map((project) => (
                  <Button
                    key={project.key}
                    size="sm"
                    variant="outline"
                    onClick={project.onOpen}
                    data-workjet-action={`project.open.calendar:${project.key}`}
                    aria-label={calText(
                      `${project.title}: Termin festlegen`,
                      `${project.title}: set meeting`,
                    )}
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
          {/* Bleibt beim Scrollen im Blick (sticky), damit ein Klick weiter
              unten im Raster die Details nicht außer Sicht öffnet. */}
          <div className="sticky top-2 z-20">
            <InlineExpand
              hideCollapseControl
              label={calText("Termindetails", "Event details")}
              open={selectedEvent !== null}
              onOpenChange={(open) => {
                if (!open) setSelectedEvent(null);
              }}
            >
              {selectedEvent !== null && (
                <section
                  aria-label={calText("Termindetails", "Event details")}
                  className="mb-4 rounded-md border border-border bg-background p-4 shadow-sm"
                  data-workjet-calendar-event-details=""
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-semibold">{selectedEvent.title}</h2>
                    <Button size="sm" variant="ghost" onClick={() => setSelectedEvent(null)}>
                      {calText("Schließen", "Close")}
                    </Button>
                  </div>
                  <p className="mt-2 text-sm">
                    {formatDateTime(selectedEvent.start_ms, timeFormat, locale)} –{" "}
                    {formatDateTime(selectedEvent.end_ms, timeFormat, locale)}
                  </p>
                  {selectedEvent.location && (
                    <p className="mt-2 text-sm">{selectedEvent.location}</p>
                  )}
                  {selectedEvent.notes && (
                    <p className="mt-2 whitespace-pre-wrap text-sm">{selectedEvent.notes}</p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {calText("Kontotermin · nur lesen", "Account event · read-only")}
                  </p>
                </section>
              )}
            </InlineExpand>
          </div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setAnchor(today)}>
              {calText("Heute", "Today")}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={calText("Zurück", "Previous")}
              onClick={() => setAnchor((previous) => shiftAnchor(view, previous, -1))}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={calText("Weiter", "Next")}
              onClick={() => setAnchor((previous) => shiftAnchor(view, previous, 1))}
            >
              <ChevronRightIcon />
            </Button>
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold" aria-live="polite">
              {rangeTitle(view, anchor, format)}
            </h2>
            <div
              role="group"
              aria-label={calText("Kalenderansicht", "Calendar view")}
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
                  {calText(option.label, VIEW_LABEL_EN[option.value] ?? option.label)}
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
    </CalendarFormatContext.Provider>
  );
}
