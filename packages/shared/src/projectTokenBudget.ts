// @effect-diagnostics globalDate:off
import {
  ProjectBudgetBillions,
  type ProjectBudgetMeeting,
  type UsageTokenTotals,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";

export const BILLION = 1_000_000_000;
export const TOKEN_BUDGET_THRESHOLDS = [50, 80, 90, 95, 98, 100] as const;
export function parseTokenBudgetBillions(text: string): number | null {
  const value = text.trim();
  if (value === "") return null;
  if (!/^\d+(?:[.,]\d)?$/.test(value)) throw new Error("Use billions with one decimal place.");
  return Schema.decodeUnknownSync(ProjectBudgetBillions)(Number(value.replace(",", ".")));
}
const parts = (at: number, zone: string) => {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const n = (kind: Intl.DateTimeFormatPartTypes) =>
    Number(values.find((p) => p.type === kind)!.value);
  return {
    year: n("year"),
    month: n("month"),
    day: n("day"),
    hour: n("hour"),
    minute: n("minute"),
    second: n("second"),
  };
};
function wallTime(day: number, hour: number, minute: number, zone: string) {
  const desired = day + hour * 3_600_000 + minute * 60_000;
  let at = desired;
  for (let n = 0; n < 4; n++) {
    const p = parts(at, zone);
    const observed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const correction = desired - observed;
    if (correction === 0) break;
    at += correction;
  }
  return at;
}
/** Calendar arithmetic preserves Monday/meeting wall time across DST changes. */
export function projectTokenCycle(now: number, meeting: ProjectBudgetMeeting | null | undefined) {
  const schedule = meeting ?? { weekday: 1, time: "00:00", timezone: "Europe/Berlin" };
  const p = parts(now, schedule.timezone);
  const today = Date.UTC(p.year, p.month - 1, p.day);
  const weekday = ((new Date(today).getUTCDay() + 6) % 7) + 1;
  const [hour, minute] = schedule.time.split(":").map(Number);
  let day = today - ((weekday - schedule.weekday + 7) % 7) * 86_400_000;
  let start = wallTime(day, hour!, minute!, schedule.timezone);
  if (start > now) {
    day -= 7 * 86_400_000;
    start = wallTime(day, hour!, minute!, schedule.timezone);
  }
  const end = wallTime(day + 7 * 86_400_000, hour!, minute!, schedule.timezone);
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    timeZone: schedule.timezone,
    kind: meeting ? ("jour-fixe" as const) : ("calendar-week" as const),
  };
}
export function projectTokenTotal(t: UsageTokenTotals) {
  return t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;
}
export function reachedTokenBudgetThresholds(
  tokens: number,
  limitBillions: number | null | undefined,
) {
  if (limitBillions == null) return [];
  const percent = (tokens / (limitBillions * BILLION)) * 100;
  return TOKEN_BUDGET_THRESHOLDS.filter((t) => (t === 100 ? percent > 100 : percent >= t));
}
/** Older clients may replace an overview, but may never erase a configured budget. */
export function reviseTokenBudgetOverview(
  previous: import("@workjet/contracts").ProjectOverview | null | undefined,
  next: import("@workjet/contracts").ProjectOverview | null,
  expectedRevision: number | undefined,
): import("@workjet/contracts").ProjectOverview | null {
  const before = previous?.tokenBudget;
  const requested = next?.tokenBudget;
  if (!requested)
    return before
      ? { ...(next ?? { websiteUrl: null, slots: [null, null, null] }), tokenBudget: before }
      : next;
  const changed =
    !before ||
    before.limitBillions !== requested.limitBillions ||
    JSON.stringify(before.jourFixe) !== JSON.stringify(requested.jourFixe);
  if (changed && expectedRevision !== (before?.revision ?? 0))
    throw new Error("Token budget changed. Reload project settings and try again.");
  return {
    ...next!,
    tokenBudget: changed ? { ...requested, revision: (before?.revision ?? 0) + 1 } : before!,
  };
}

export function tokenBudgetNotice(
  tokens: number,
  limitBillions: number,
  threshold: number,
  end: string,
  now: number,
) {
  const number = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
  const date = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(end));
  const hours = Math.max(0, Math.floor((Date.parse(end) - now) / 3_600_000));
  return `Token-Budget: ${threshold === 100 ? "Budget überschritten" : threshold + " % erreicht"}, ${number.format(tokens / BILLION)} von ${number.format(limitBillions)}B, nächster Zyklus/Regeltermin ${date}, noch ${Math.floor(hours / 24)} Tage ${hours % 24} h. Die Arbeit läuft weiter; bereite Deck, Bericht und offene Entscheidungen vorrangig vor.`;
}
