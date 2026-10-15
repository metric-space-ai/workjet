/**
 * Deutsche Datums-, Stunden- und Zahlenformate für Einstellungen › Verbrauch
 * (de-DE: „1.284,37 $“, „76,7 Mio.“, „12,3 %“).
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

const USD_DE = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER_DE = new Intl.NumberFormat("de-DE");

/** `1284.37` → `1.284,37 $` */
export function formatUsageUsd(value: number): string {
  return USD_DE.format(value);
}

/** Fehlende Preise bleiben von bekannten Nullkosten unterscheidbar. */
export function formatUsageCostDe(value: number, unpriced: number): string {
  if (unpriced > 0) return value > 0 ? `${formatUsageUsd(value)} + unbekannt` : "Unbekannt";
  return formatUsageUsd(value);
}

function trimDe(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value
    .toFixed(digits)
    .replace(/\.0+$/u, "")
    .replace(/(\.\d*?)0+$/u, "$1")
    .replace(".", ",");
}

/** Token kompakt mit drei Stellen: `76,7 Mio.`, `804 Tsd.`, `950`. */
export function formatUsageTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trimDe(value / 1e12)} Bio.`;
  if (abs >= 1e9) return `${trimDe(value / 1e9)} Mrd.`;
  if (abs >= 1e6) return `${trimDe(value / 1e6)} Mio.`;
  if (abs >= 1e3) return `${trimDe(value / 1e3)} Tsd.`;
  return INTEGER_DE.format(Math.round(value));
}

/** `0.123` → `12,3 %` */
export function formatUsagePercent(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits).replace(".", ",")} %`;
}
