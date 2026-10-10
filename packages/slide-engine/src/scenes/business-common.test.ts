import { describe, expect, it } from "vite-plus/test";

import {
  businessPalette,
  contrastRatio,
  dropOverlappingLabels,
  estimateTextWidth,
  formatBusinessNumber,
  kpiBarsLayout,
  kpiDelta,
  parseBusinessSceneData,
  spreadVertically,
  trendAxisLabelIndices,
  trendDomain,
  trendLayout,
  wrapText,
} from "./business-common";
import type { KpiBarsData, TrendData } from "./business-data";

const jourFixeKpis: KpiBarsData = {
  items: [
    { label: "Umsatz MRR", value: 18400, previous: 16900, unit: "€" },
    { label: "Aktive Nutzer", value: 1240, previous: 1310 },
    { label: "Gemergte PRs", value: 23, previous: 17 },
    { label: "Offene Bugs", value: 9, previous: 14, better: "lower" },
  ],
};

const exitValue: TrendData = {
  label: "Exitwert E5",
  unit: "Mio €",
  target: 5,
  points: [
    { label: "14.08.", value: 3.1 },
    { label: "21.08.", value: 3.4 },
    { label: "28.08.", value: 3.2 },
    { label: "04.09.", value: 3.9 },
    { label: "11.09.", value: 4.4 },
    { label: "18.09.", value: 4.8 },
  ],
};

describe("formatBusinessNumber", () => {
  it("uses German separators, a typographic minus and the unit", () => {
    expect(formatBusinessNumber(18400, "€")).toBe("18.400 €");
    expect(formatBusinessNumber(4.8, "Mio €")).toBe("4,8 Mio €");
    expect(formatBusinessNumber(23.46)).toBe("23,5");
    expect(formatBusinessNumber(-1250)).toBe("−1.250");
  });
});

describe("kpiDelta", () => {
  it("computes the relative change against the previous value", () => {
    const delta = kpiDelta(18400, 16900);
    expect(delta.percent).toBeCloseTo(8.876, 3);
    expect(delta.text).toBe("+8,9 %");
    expect(delta.tone).toBe("better");
  });

  it("colours a decrease as improvement when lower is better", () => {
    const bugs = kpiDelta(9, 14, "lower");
    expect(bugs.text).toBe("−35,7 %");
    expect(bugs.tone).toBe("better");
    expect(kpiDelta(14, 9, "lower").tone).toBe("worse");
    expect(kpiDelta(1240, 1310).tone).toBe("worse");
  });

  it("stays neutral without change and falls back to the absolute change after zero", () => {
    expect(kpiDelta(5, 5)).toMatchObject({ tone: "neutral", text: "±0,0 %" });
    expect(kpiDelta(3, 0, "higher", "PRs")).toMatchObject({
      percent: null,
      text: "+3 PRs",
      tone: "better",
    });
  });

  it("measures change against the magnitude of a negative previous value", () => {
    expect(kpiDelta(-50, -100).percent).toBeCloseTo(50);
    expect(kpiDelta(-50, -100).tone).toBe("better");
  });
});

describe("kpiBarsLayout", () => {
  it("normalises every KPI to its own maximum when units differ", () => {
    const layout = kpiBarsLayout(jourFixeKpis);
    expect(layout.scale).toBe("per-item");
    const [revenue, users, prs, bugs] = layout.items;
    expect(revenue?.height).toBe(1);
    expect(revenue?.previousHeight).toBeCloseTo(16900 / 18400);
    expect(users?.height).toBeCloseTo(1240 / 1310);
    expect(users?.previousHeight).toBe(1);
    expect(prs?.previousHeight).toBeCloseTo(17 / 23);
    expect(bugs?.height).toBeCloseTo(9 / 14);
    expect(bugs?.delta?.tone).toBe("better");
    expect(revenue?.valueText).toBe("18.400 €");
    expect(layout.hasPrevious).toBe(true);
    expect(layout.positiveExtent).toBe(1);
    expect(layout.negativeExtent).toBe(0);
  });

  it("shares one scale when units match and magnitudes are comparable", () => {
    const layout = kpiBarsLayout({
      unit: "h",
      items: [
        { label: "Support", value: 40 },
        { label: "Entwicklung", value: 120, previous: 100 },
      ],
    });
    expect(layout.scale).toBe("shared");
    expect(layout.items[0]?.height).toBeCloseTo(40 / 120);
    expect(layout.items[1]?.height).toBe(1);
    expect(layout.items[0]?.valueText).toBe("40 h");
  });

  it("falls back to per-item scaling when one KPI would shrink to a sliver", () => {
    const layout = kpiBarsLayout({
      items: [
        { label: "Nutzer", value: 1240 },
        { label: "PRs", value: 23 },
      ],
    });
    expect(layout.scale).toBe("per-item");
  });

  it("centres the slots and reserves room for negative values", () => {
    const layout = kpiBarsLayout({
      items: [
        { label: "Cashflow", value: -20, previous: 10, unit: "T€" },
        { label: "Marge", value: 30, unit: "T€" },
      ],
    });
    expect(layout.items.map((item) => item.x)).toEqual([-0.9, 0.9]);
    expect(layout.scale).toBe("shared");
    expect(layout.items[0]?.height).toBeCloseTo(-20 / 30);
    expect(layout.negativeExtent).toBeCloseTo(20 / 30);
    expect(layout.positiveExtent).toBe(1);
    expect(layout.items[0]?.delta?.tone).toBe("worse");
  });

  it("keeps an all-zero scene drawable", () => {
    const layout = kpiBarsLayout({ items: [{ label: "Vorfälle", value: 0, previous: 0 }] });
    expect(layout.items[0]?.height).toBe(0);
    expect(layout.positiveExtent).toBe(1);
  });
});

describe("trendLayout", () => {
  it("pads the value domain around values and target", () => {
    const [lo, hi] = trendDomain([10, 20]);
    expect(lo).toBeCloseTo(7.6);
    expect(hi).toBeCloseTo(21.2);
    expect(trendDomain([5, 5])).toEqual([4, 5.5]);
    expect(trendDomain([0, 0])).toEqual([-2, 1]);
  });

  it("places points, target and the large last value", () => {
    const layout = trendLayout(exitValue);
    expect(layout.points.map((point) => point.t)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const [lo, hi] = layout.domain;
    expect(lo).toBeCloseTo(3.1 - 1.9 * 0.24);
    expect(hi).toBeCloseTo(5 + 1.9 * 0.12);
    expect(layout.target?.y).toBeCloseTo((5 - lo) / (hi - lo));
    expect(layout.target?.text).toBe("Ziel 5 Mio €");
    expect(layout.lastText).toBe("4,8 Mio €");
    expect(layout.changeText).toBe("+9,1 % ggü. Vorwert");
    expect(layout.maxIndex).toBe(5);
    expect(layout.minIndex).toBe(0);
  });

  it("labels first, minimum and maximum but leaves the last value to the large number", () => {
    const layout = trendLayout({
      label: "Burn",
      points: [
        { label: "A", value: 4 },
        { label: "B", value: 9 },
        { label: "C", value: 1 },
        { label: "D", value: 5 },
      ],
    });
    expect(layout.valueLabels).toEqual([
      { index: 1, placement: "above" },
      { index: 2, placement: "below" },
      { index: 0, placement: "above" },
    ]);
    const rising = trendLayout(exitValue);
    expect(rising.valueLabels).toEqual([{ index: 0, placement: "below" }]);
  });

  it("thins out time labels for long series", () => {
    expect(trendAxisLabelIndices(6)).toEqual([0, 1, 2, 3, 4, 5]);
    const many = trendAxisLabelIndices(24);
    expect(many[0]).toBe(0);
    expect(many[many.length - 1]).toBe(23);
    expect(many.length).toBeLessThanOrEqual(7);
  });
});

describe("label placement helpers", () => {
  it("drops colliding value labels, keeping the earlier ones", () => {
    const kept = dropOverlappingLabels(
      [
        { index: 0, placement: "above" },
        { index: 1, placement: "above" },
        { index: 4, placement: "above" },
      ],
      (index) => index,
      () => 0,
      () => 1.5,
      0.3,
    );
    expect(kept.map((label) => label.index)).toEqual([0, 4]);
  });

  it("spreads stacked annotations apart in order", () => {
    expect(
      spreadVertically(
        [
          { center: 10, height: 4 },
          { center: 11, height: 2 },
        ],
        1,
      ),
    ).toEqual([10, 14]);
    expect(
      spreadVertically([
        { center: 30, height: 4 },
        { center: 10, height: 2 },
      ]),
    ).toEqual([30, 10]);
  });

  it("wraps long labels into two lines with an ellipsis", () => {
    const measure = (value: string) => estimateTextWidth(value, 10);
    const lines = wrapText(
      "Durchschnittliche Bearbeitungszeit offener Kundentickets im Support",
      80,
      2,
      measure,
    );
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => measure(line) <= 80)).toBe(true);
    expect(lines[1]?.endsWith("…")).toBe(true);
    expect(wrapText("Umsatz MRR", 80, 2, measure)).toEqual(["Umsatz MRR"]);
    expect(wrapText("Ø Bearbeitungszeit offener Tickets", 100, 3, measure)).toEqual([
      "Ø Bearbeitungs-",
      "zeit offener",
      "Tickets",
    ]);
    const compound = wrapText("Kundenzufriedenheitsindex", 80, 2, measure);
    expect(compound[0]?.endsWith("-")).toBe(true);
    expect(compound.every((line) => measure(line) <= 80)).toBe(true);
  });
});

describe("businessPalette", () => {
  it("keeps a requested pale accent for fills but darkens it for strokes and text", () => {
    const palette = businessPalette(false, "#e5c48c");
    expect(palette.accentFill).toBe("#e5c48c");
    expect(contrastRatio(palette.accentInk, palette.paper)).toBeGreaterThanOrEqual(3);
    expect(businessPalette(true).accentFill).toBe("#a8a5ff");
    expect(businessPalette(false, "not-a-colour").accentFill).toBe("#6965db");
  });
});

describe("parseBusinessSceneData", () => {
  it("accepts data that matches the contract", () => {
    const result = parseBusinessSceneData("business.kpi-bars", jourFixeKpis);
    expect(result.ok).toBe(true);
  });

  it("explains missing data in German", () => {
    const result = parseBusinessSceneData("business.trend", undefined);
    expect(result).toEqual({
      ok: false,
      message: "Die Verlaufs-Szene „business.trend“ kann nicht angezeigt werden: Die Daten fehlen.",
    });
  });

  it("names the offending field for invalid data", () => {
    const result = parseBusinessSceneData("business.kpi-bars", {
      items: [{ label: "Umsatz", value: "viel" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Die Daten sind ungültig");
      expect(result.message).toContain("items.0.value");
    }
    const tooMany = parseBusinessSceneData("business.kpi-bars", {
      items: Array.from({ length: 9 }, (_, index) => ({ label: `K${index}`, value: index })),
    });
    expect(tooMany.ok).toBe(false);
  });
});
