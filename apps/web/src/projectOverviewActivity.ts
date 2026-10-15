/** Worker activity for the project overview, derived from each worker's latest turn. */

export type ActivityWorker = {
  readonly key: string;
  readonly latestTurn: {
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
};

export type ActivityInterval = {
  readonly workerKey: string;
  readonly start: number;
  readonly end: number;
};

const MINUTE_MS = 60_000;

/** A turn that is still running counts as active until `now`. Turns without a parseable start are skipped. */
export function activityIntervals(
  workers: readonly ActivityWorker[],
  now: number,
): ActivityInterval[] {
  return workers.flatMap((worker) => {
    const turn = worker.latestTurn;
    if (!turn?.startedAt) return [];
    const start = Date.parse(turn.startedAt);
    if (!Number.isFinite(start)) return [];
    const parsedEnd = turn.completedAt === null ? now : Date.parse(turn.completedAt);
    const end = Math.min(Number.isFinite(parsedEnd) ? parsedEnd : now, now);
    return end > start ? [{ workerKey: worker.key, start, end }] : [];
  });
}

function localDayStart(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function nextLocalDayStart(dayStart: number): number {
  const date = new Date(dayStart);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function overlapMinutes(interval: ActivityInterval, from: number, to: number): number {
  return Math.max(0, Math.min(interval.end, to) - Math.max(interval.start, from)) / MINUTE_MS;
}

/** Active minutes for each local hour of the day that contains `dayStart`. */
export function hourlyActivity(intervals: readonly ActivityInterval[], dayStart: number): number[] {
  const dayEnd = nextLocalDayStart(dayStart);
  const hours: number[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const from = new Date(new Date(dayStart).setHours(hour, 0, 0, 0)).getTime();
    const to = Math.min(new Date(new Date(dayStart).setHours(hour + 1, 0, 0, 0)).getTime(), dayEnd);
    hours.push(intervals.reduce((sum, interval) => sum + overlapMinutes(interval, from, to), 0));
  }
  return hours;
}

/** Active minutes per local day, keyed by local date (YYYY-MM-DD). Intervals spanning midnight are split. */
export function dailyActivity(intervals: readonly ActivityInterval[]): Map<string, number> {
  const days = new Map<string, number>();
  for (const interval of intervals) {
    let cursor = interval.start;
    while (cursor < interval.end) {
      const dayStart = localDayStart(cursor);
      const dayEnd = nextLocalDayStart(dayStart);
      const minutes = overlapMinutes(interval, cursor, dayEnd);
      const key = localDateKey(dayStart);
      days.set(key, (days.get(key) ?? 0) + minutes);
      cursor = dayEnd;
    }
  }
  return days;
}

export function localDateKey(time: number): string {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export type ActivityCell = {
  readonly key: string;
  readonly minutes: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
};

/**
 * A heatmap of whole weeks ending with the week of `now`, Monday first.
 * Columns are weeks, rows are weekdays. Days after `now` are null.
 */
export function activityHeatmap(
  days: ReadonlyMap<string, number>,
  now: number,
  weeks: number,
): (ActivityCell | null)[][] {
  const today = new Date(localDayStart(now));
  const mondayOffset = (today.getDay() + 6) % 7;
  const firstMonday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - mondayOffset - (weeks - 1) * 7,
  );
  const max = Math.max(0, ...days.values());
  const levelFor = (minutes: number): 0 | 1 | 2 | 3 | 4 => {
    if (minutes <= 0 || max <= 0) return 0;
    const ratio = minutes / max;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  };
  return Array.from({ length: 7 }, (_, weekday) =>
    Array.from({ length: weeks }, (_, week) => {
      const date = new Date(
        firstMonday.getFullYear(),
        firstMonday.getMonth(),
        firstMonday.getDate() + week * 7 + weekday,
      );
      if (date.getTime() > today.getTime()) return null;
      const key = localDateKey(date.getTime());
      const minutes = days.get(key) ?? 0;
      return { key, minutes, level: levelFor(minutes) };
    }),
  );
}

export type ActivitySummary = {
  readonly workers: number;
  readonly activeDays: number;
  readonly totalMinutes: number;
};

/** Totals for the heatmap window; workers are counted only when they were active inside it. */
export function activitySummary(
  intervals: readonly ActivityInterval[],
  heatmap: readonly (readonly (ActivityCell | null)[])[],
): ActivitySummary {
  const cells = heatmap.flat().filter((cell): cell is ActivityCell => cell !== null);
  const first = cells.map((cell) => cell.key).sort()[0];
  const windowStart = first ? new Date(`${first}T00:00:00`).getTime() : Number.POSITIVE_INFINITY;
  const inWindow = intervals.filter((interval) => interval.end > windowStart);
  return {
    workers: new Set(inWindow.map((interval) => interval.workerKey)).size,
    activeDays: cells.filter((cell) => cell.minutes > 0).length,
    totalMinutes: cells.reduce((sum, cell) => sum + cell.minutes, 0),
  };
}
