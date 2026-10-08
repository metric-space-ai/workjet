import { describe, expect, it } from "vite-plus/test";
import { essentialKpiPresentation, formatEssentialKpiEur } from "./projectEssentialKpi";

const ready = {
  status: "ready" as const,
  calculatedAt: 1,
  expectedSalePriceEur: 6_119_223,
  probabilityOfSale: 0.58,
  conditionalSalePriceEur: 10_550_385,
  p10Eur: 0,
  medianEur: 265_504,
  p90Eur: 25_468_218,
  previousExpectedSalePriceEur: 4_000_000,
};

describe("essential KPI presentation", () => {
  it("shows E5 rounded to 0.1 Mio. EUR with the change against the previous Jour fixe", () => {
    const view = essentialKpiPresentation(ready);
    expect(view.status).toBe("ready");
    expect(view.value).toBe("6.1 Mio. EUR");
    expect(view.detail).toBe("58 % chance of a sale");
    expect(view.changePercent).toBeCloseTo(52.98, 1);
  });

  it("has no change figure for the first snapshot", () => {
    const view = essentialKpiPresentation({ ...ready, previousExpectedSalePriceEur: null });
    expect(view.changePercent).toBeNull();
  });

  it("shows a blocked snapshot with its missing prerequisite instead of an amount", () => {
    expect(
      essentialKpiPresentation({ status: "blocked", missing: "No sale price basis yet" }),
    ).toEqual({ status: "blocked", value: "—", detail: "No sale price basis yet" });
  });

  it("does not show a value before the supervisor has written a snapshot", () => {
    expect(essentialKpiPresentation(null)).toMatchObject({ status: "blocked", value: "—" });
  });

  it("rejects a snapshot whose probability or percentiles cannot be right", () => {
    expect(essentialKpiPresentation({ ...ready, probabilityOfSale: 1.2 })).toMatchObject({
      status: "blocked",
    });
    expect(essentialKpiPresentation({ ...ready, p10Eur: 300_000 })).toMatchObject({
      status: "blocked",
    });
  });

  it("shows no range for a contract v1 snapshot without quantiles", () => {
    const { p10Eur, medianEur, p90Eur, ...v1 } = ready;
    expect(essentialKpiPresentation(v1)).toMatchObject({ status: "ready", range: null });
  });

  it("shows the range only when all three quantiles are present", () => {
    expect(essentialKpiPresentation(ready)).toMatchObject({
      range: "0.0 Mio. EUR – 25.5 Mio. EUR",
    });
    const { p90Eur, ...partial } = ready;
    expect(essentialKpiPresentation(partial)).toMatchObject({ status: "blocked" });
  });

  it("formats whole amounts without scientific notation", () => {
    expect(formatEssentialKpiEur(0)).toBe("0.0 Mio. EUR");
    expect(formatEssentialKpiEur(25_468_218)).toBe("25.5 Mio. EUR");
  });
});
