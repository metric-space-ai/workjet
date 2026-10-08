/**
 * The Essential KPI adapts the five-year exit model's E5 for the project overview:
 * the expected realizable sale price for 100 % of a project's equity after 60 months,
 * probability-weighted over every outcome, including outcomes without a sale.
 *
 * CTOX's deterministic core computes these numbers at each Jour fixe close. An agent
 * researches the inputs but never sets the figures, and the browser only presents them.
 */

export type EssentialKpiSnapshot =
  | {
      readonly status: "blocked";
      /** The concrete missing prerequisite, shown instead of an invented amount. */
      readonly missing: string;
    }
  | {
      readonly status: "ready" | "provisional";
      readonly calculatedAt: number;
      /** E5: expected sale proceeds, EUR, nominal at the horizon, before transaction costs and taxes. */
      readonly expectedSalePriceEur: number;
      /** Probability that a sale closes by the horizon, 0..1. */
      readonly probabilityOfSale: number;
      /** Sale price if a sale happens, EUR. Null when the model has no sale outcome. */
      readonly conditionalSalePriceEur: number | null;
      /** Quantiles exist only once the model simulates; the contract v1 snapshot omits them. */
      readonly p10Eur?: number;
      readonly medianEur?: number;
      readonly p90Eur?: number;
      /** E5 from the second-to-last regular Jour fixe. Null for the first snapshot. */
      readonly previousExpectedSalePriceEur: number | null;
    };

export type EssentialKpiPresentation =
  | { readonly status: "blocked"; readonly value: "—"; readonly detail: string }
  | {
      readonly status: "ready" | "provisional";
      readonly value: string;
      readonly detail: string;
      /** Change against the previous regular Jour fixe, in percent. Null without a usable baseline. */
      readonly changePercent: number | null;
      /** Range text when all three quantiles are present, otherwise null. */
      readonly range: string | null;
    };

const MILLION = 1_000_000;

/** E5 is shown rounded to 0.1 Mio. EUR, as the concept asks for the overview. */
export function formatEssentialKpiEur(amount: number): string {
  return `${(amount / MILLION).toFixed(1)} Mio. EUR`;
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isAmount(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Invalid snapshots are shown as blocked rather than as a number that cannot be explained. */
export function essentialKpiPresentation(
  snapshot: EssentialKpiSnapshot | null | undefined,
): EssentialKpiPresentation {
  if (!snapshot) {
    return { status: "blocked", value: "—", detail: "Set up by the supervisor at the next Jour fixe" };
  }
  if (snapshot.status === "blocked") {
    return { status: "blocked", value: "—", detail: snapshot.missing };
  }
  const { p10Eur, medianEur, p90Eur } = snapshot;
  const hasRange = p10Eur !== undefined || medianEur !== undefined || p90Eur !== undefined;
  const rangeValid =
    !hasRange ||
    (p10Eur !== undefined &&
      medianEur !== undefined &&
      p90Eur !== undefined &&
      isAmount(p10Eur) &&
      isAmount(medianEur) &&
      isAmount(p90Eur) &&
      p10Eur <= medianEur &&
      medianEur <= p90Eur);
  const valid =
    isAmount(snapshot.expectedSalePriceEur) &&
    isProbability(snapshot.probabilityOfSale) &&
    (snapshot.conditionalSalePriceEur === null || isAmount(snapshot.conditionalSalePriceEur)) &&
    rangeValid;
  if (!valid) {
    return { status: "blocked", value: "—", detail: "Snapshot failed validation" };
  }
  const previous = snapshot.previousExpectedSalePriceEur;
  const changePercent =
    previous !== null && isAmount(previous) && previous > 0
      ? ((snapshot.expectedSalePriceEur - previous) / previous) * 100
      : null;
  const chance = `${Math.round(snapshot.probabilityOfSale * 100)} % chance of a sale`;
  return {
    status: snapshot.status,
    value: formatEssentialKpiEur(snapshot.expectedSalePriceEur),
    detail: chance,
    changePercent,
    range:
      p10Eur !== undefined && p90Eur !== undefined
        ? `${formatEssentialKpiEur(p10Eur)} – ${formatEssentialKpiEur(p90Eur)}`
        : null,
  };
}
