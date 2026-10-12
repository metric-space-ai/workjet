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

/** First day of a calendar week. Monday follows ISO 8601 / DIN 1355, the default. */
export type WeekStart = "monday" | "sunday";

export function startOfWeek(key: DateKey, weekStart: WeekStart = "monday"): DateKey {
  const offset = weekStart === "sunday" ? isoWeekday(key) % 7 : isoWeekday(key) - 1;
  return addDays(key, -offset);
}

export function startOfMonth(key: DateKey): DateKey {
  return `${key.slice(0, 7)}-01`;
}

export function startOfYear(key: DateKey): DateKey {
  return `${key.slice(0, 4)}-01-01`;
}

/** Six full weeks, so the grid height never changes between months. */
export function monthGrid(key: DateKey, weekStart: WeekStart = "monday"): readonly DateKey[] {
  const start = startOfWeek(startOfMonth(key), weekStart);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function isSameMonth(a: DateKey, b: DateKey): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/**
 * Calendar formatting follows the app's active UI language (Einstellungen ›
 * Allgemein › Sprache), not hardcoded strings: month and weekday names, date
 * order, ranges, hour cycle and week start all come from Intl for that locale.
 * New UI languages only need an entry in `calendarLocale`.
 */
export const DEFAULT_CALENDAR_LOCALE = "de-DE";

/**
 * BCP 47 locale for a UI language. A regional browser locale of the same
 * language wins (en-GB stays en-GB), otherwise a sensible default region.
 */
export function calendarLocale(uiLanguage: string, browserLanguage?: string): string {
  const language = uiLanguage.toLowerCase().split("-")[0] ?? "";
  const browser = browserLanguage?.trim();
  if (browser && browser.toLowerCase().split("-")[0] === language && browser.includes("-")) {
    try {
      return new Intl.Locale(browser).toString();
    } catch {
      // fall through to the default region
    }
  }
  const defaults: Record<string, string> = { de: "de-DE", en: "en-US" };
  return defaults[language] ?? (language || DEFAULT_CALENDAR_LOCALE);
}

/** "monday" or "sunday" as the locale prefers; other first days fall back to Monday. */
export function localeWeekStart(locale: string): WeekStart {
  try {
    const intlLocale = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = intlLocale.getWeekInfo?.().firstDay ?? intlLocale.weekInfo?.firstDay;
    return firstDay === 7 ? "sunday" : "monday";
  } catch {
    return "monday";
  }
}

/** Resolves an "auto" week-start preference against the locale. */
export function resolveWeekStart(preference: WeekStart | "locale", locale: string): WeekStart {
  return preference === "locale" ? localeWeekStart(locale) : preference;
}

export function formatDateKey(
  key: DateKey,
  options: Intl.DateTimeFormatOptions,
  locale: string = DEFAULT_CALENDAR_LOCALE,
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(keyToUtc(key));
}

/** A date range: "12.–18. Okt. 2026" (de-DE), "Oct 12 – 18, 2026" (en-US). */
export function formatDateKeyRange(
  from: DateKey,
  to: DateKey,
  locale: string = DEFAULT_CALENDAR_LOCALE,
): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).formatRange(keyToUtc(from), keyToUtc(to));
}

/** "12-hour" or "24-hour" override; "locale" follows the calendar locale. */
export type CalendarTimeFormat = "locale" | "12-hour" | "24-hour";

function hourCycleOptions(format: CalendarTimeFormat): Intl.DateTimeFormatOptions {
  if (format === "12-hour") return { hourCycle: "h12" };
  if (format === "24-hour") return { hourCycle: "h23" };
  return {};
}

function uses12Hour(format: CalendarTimeFormat, locale: string): boolean {
  if (format !== "locale") return format === "12-hour";
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h12" || cycle === "h11";
}

/** Wall-clock time of an instant: "13:00" (de-DE) or "1:00 PM" (en-US). */
export function formatClockTime(
  ms: number,
  format: CalendarTimeFormat = "locale",
  timeZone?: string,
  locale: string = DEFAULT_CALENDAR_LOCALE,
): string {
  return new Intl.DateTimeFormat(locale, {
    hour: uses12Hour(format, locale) ? "numeric" : "2-digit",
    minute: "2-digit",
    ...hourCycleOptions(format),
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(ms);
}

/** Hour label for the time grid: "13:00" on a 24-hour clock, "1 PM" on a 12-hour one. */
export function formatHourLabel(
  hour: number,
  format: CalendarTimeFormat = "locale",
  locale: string = DEFAULT_CALENDAR_LOCALE,
): string {
  if (uses12Hour(format, locale)) {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", hourCycle: "h12" }).format(
      new Date(2000, 0, 1, hour),
    );
  }
  return `${String(hour).padStart(2, "0")}:00`;
}

/** Date plus time of an instant, e.g. "12. Okt. 2026, 13:00". */
export function formatDateTime(
  ms: number,
  format: CalendarTimeFormat = "locale",
  locale: string = DEFAULT_CALENDAR_LOCALE,
): string {
  const date = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(ms);
  return `${date}, ${formatClockTime(ms, format, undefined, locale)}`;
}

/** ISO 8601 calendar week number (KW). */
export function isoWeekNumber(key: DateKey): number {
  const thursday = addDays(key, 4 - isoWeekday(key));
  const yearStart = keyToUtc(startOfYear(thursday));
  return Math.floor((keyToUtc(thursday) - yearStart) / DAY_MS / 7) + 1;
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
