/**
 * Deutsche Datums- und Stundenbeschriftungen für Einstellungen › Verbrauch.
 * Die Zahlenformate (Tokens, USD) bleiben in `@workjet/shared/usageFormat`.
 */

/** `2026-08-07` → `7. Aug.` */
export function formatUsageDay(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (!year || !month || !dayOfMonth) return day;
  return new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, dayOfMonth)));
}

/** Stundenbeginn → `14 Uhr` in der Zeitzone des Fensters. */
export function formatUsageHour(hourStart: string, timeZone?: string): string {
  const instant = new Date(hourStart);
  if (Number.isNaN(instant.getTime())) return hourStart;
  // de-DE hängt „Uhr“ bei reiner Stundenangabe je nach ICU selbst an; nur die
  // Stundenziffern übernehmen, damit es genau einmal dasteht.
  const hour = new Intl.DateTimeFormat("de-DE", {
    ...(timeZone === undefined ? {} : { timeZone }),
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(instant)
    .find((part) => part.type === "hour")?.value;
  return hour === undefined ? hourStart : `${hour} Uhr`;
}

/** Zeitpunkt → `11. Okt., 14 Uhr`. */
export function formatUsageDateTime(instant: string, timeZone?: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  const day = new Intl.DateTimeFormat("de-DE", {
    ...(timeZone === undefined ? {} : { timeZone }),
    day: "numeric",
    month: "short",
  }).format(date);
  return `${day}, ${formatUsageHour(instant, timeZone)}`;
}
