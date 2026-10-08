/**
 * Calendar dates are "YYYY-MM-DD" keys. Day arithmetic runs in UTC so that no
 * local offset can shift a date; instants are only converted when a zone is
 * involved.
 */
export type DateKey = string;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export function dateKey(year: number, month: number, day: number): DateKey {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function keyToUtc(key: DateKey): number {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function utcToKey(ms: number): DateKey {
  const date = new Date(ms);
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addDays(key: DateKey, days: number): DateKey {
  return utcToKey(keyToUtc(key) + days * DAY_MS);
}

/** Clamps the day of month, so Jan 31 plus one month is Feb 28 (or 29). */
export function addMonths(key: DateKey, months: number): DateKey {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return dateKey(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(day, lastDay));
}

/** ISO weekday: Monday is 1, Sunday is 7. */
export function isoWeekday(key: DateKey): number {
  const sundayBased = new Date(keyToUtc(key)).getUTCDay();
  return sundayBased === 0 ? 7 : sundayBased;
}

export function startOfWeek(key: DateKey): DateKey {
  return addDays(key, 1 - isoWeekday(key));
}

export function startOfMonth(key: DateKey): DateKey {
  return `${key.slice(0, 7)}-01`;
}

export function startOfYear(key: DateKey): DateKey {
  return `${key.slice(0, 4)}-01-01`;
}

/** Six full weeks, Monday first, so the grid height never changes between months. */
export function monthGrid(key: DateKey): readonly DateKey[] {
  const start = startOfWeek(startOfMonth(key));
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function isSameMonth(a: DateKey, b: DateKey): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

export function formatDateKey(key: DateKey, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(keyToUtc(key));
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Formatter construction is slow and the grid reads many instants, so one is kept per zone.
const readingFormatters = new Map<string, Intl.DateTimeFormat>();

function readingFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = readingFormatters.get(timeZone);
  if (formatter == null) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    readingFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClockUtc(ms: number, timeZone: string): number {
  const reading = zonedReading(ms, timeZone);
  return keyToUtc(reading.date) + reading.minutes * MINUTE_MS;
}

function offsetMs(ms: number, timeZone: string): number {
  return wallClockUtc(ms, timeZone) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** The calendar date and minute of day an instant reads as in a zone. */
export function zonedReading(
  ms: number,
  timeZone: string,
): { readonly date: DateKey; readonly minutes: number } {
  const parts = readingFormatter(timeZone).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    date: dateKey(read("year"), read("month"), read("day")),
    minutes: read("hour") * 60 + read("minute"),
  };
}

/** The instant at which a wall-clock time occurs in a zone. The second pass settles DST edges. */
export function instantOf(date: DateKey, minutes: number, timeZone: string): number {
  const wall = keyToUtc(date) + minutes * MINUTE_MS;
  const first = wall - offsetMs(wall, timeZone);
  return wall - offsetMs(first, timeZone);
}

export type WeeklyRule = {
  readonly weekday: number;
  readonly time: string;
  readonly timezone: string;
};

export type Occurrence = {
  readonly startMs: number;
  /** Date and minute of the start in the display zone. */
  readonly date: DateKey;
  readonly minutes: number;
};

/**
 * Every occurrence of a weekly rule whose start falls on a display-zone date
 * between `from` and `to` (both inclusive). The rule keeps its own weekday,
 * time and zone; only the rendering moves to the display zone.
 */
export function weeklyOccurrences(
  rule: WeeklyRule,
  from: DateKey,
  to: DateKey,
  displayZone: string,
): readonly Occurrence[] {
  const [hours = 0, minutesPart = 0] = rule.time.split(":").map(Number);
  const minutes = hours * 60 + minutesPart;
  const occurrences: Occurrence[] = [];
  const last = addDays(to, 1);
  for (let day = addDays(from, -1); day <= last; day = addDays(day, 1)) {
    if (isoWeekday(day) !== rule.weekday) continue;
    const startMs = instantOf(day, minutes, rule.timezone);
    const local = zonedReading(startMs, displayZone);
    if (local.date >= from && local.date <= to) {
      occurrences.push({ startMs, date: local.date, minutes: local.minutes });
    }
  }
  return occurrences;
}
