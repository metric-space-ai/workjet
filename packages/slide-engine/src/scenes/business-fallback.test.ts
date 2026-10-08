import { describe, expect, it } from "vite-plus/test";

import type { KpiBarsData, TrendData } from "./business-data";
import { businessFallbackDataUri, businessFallbackSvg } from "./business-fallback";

const kpis: KpiBarsData = {
  items: [
    { label: "Umsatz MRR", value: 18400, previous: 16900, unit: "€" },
    { label: "Aktive Nutzer", value: 1240, previous: 1310 },
    { label: "Gemergte PRs", value: 23, previous: 17 },
    { label: "Offene Bugs", value: 9, previous: 14, better: "lower" }
  ]
};

const trend: TrendData = {
  label: "Exitwert E5",
  unit: "Mio €",
  target: 5,
  points: [
    { label: "14.08.", value: 3.1 },
    { label: "21.08.", value: 3.4 },
    { label: "28.08.", value: 3.2 },
    { label: "04.09.", value: 3.9 },
    { label: "11.09.", value: 4.4 },
    { label: "18.09.", value: 4.8 }
  ]
};

describe("businessFallbackSvg: kpi-bars", () => {
  it("contains labels, values and coloured deltas", () => {
    const svg = businessFallbackSvg("business.kpi-bars", kpis);
    for (const label of ["Umsatz MRR", "Aktive Nutzer", "Gemergte PRs", "Offene Bugs"]) expect(svg).toContain(label);
    expect(svg).toContain("18.400 €");
    expect(svg).toContain(`fill="#2b8a3e" text-anchor="middle">+8,9 %`);
    expect(svg).toContain(`fill="#c92a2a" text-anchor="middle">−5,3 %`);
    // Fewer open bugs is an improvement.
    expect(svg).toContain(`fill="#2b8a3e" text-anchor="middle">−35,7 %`);
    expect(svg).toContain("je Kennzahl skaliert");
    expect(svg).toContain(`stroke-dasharray="4 3"`);
  });

  it("hides ghost bars and deltas when previous values are switched off", () => {
    const svg = businessFallbackSvg("business.kpi-bars", kpis, { showPrevious: false });
    expect(svg).not.toContain("%");
    expect(svg).not.toContain(`stroke-dasharray="4 3"`);
    expect(svg).toContain("Gemergte PRs");
  });

  it("is deterministic and follows the dark theme", () => {
    expect(businessFallbackSvg("business.kpi-bars", kpis, { dark: true })).toBe(businessFallbackSvg("business.kpi-bars", kpis, { dark: true }));
    const dark = businessFallbackSvg("business.kpi-bars", kpis, { dark: true });
    expect(dark).toContain(`fill="#121212"`);
    expect(dark).toContain(`fill="#8ce99a"`);
    expect(businessFallbackSvg("business.kpi-bars", kpis, { transparent: true })).not.toContain(`<rect width=`);
  });

  it("escapes label text", () => {
    const svg = businessFallbackSvg("business.kpi-bars", { items: [{ label: "R&D <Budget>", value: 3 }] }, { label: "A \"quoted\" name" });
    expect(svg).toContain("R&amp;D &lt;Budget&gt;");
    expect(svg).toContain("aria-label=\"2D-Ersatzansicht: A &quot;quoted&quot; name\"");
  });
});

describe("businessFallbackSvg: trend", () => {
  it("shows the series, the large last value, the change and the target", () => {
    const svg = businessFallbackSvg("business.trend", trend);
    expect(svg).toContain("Exitwert E5 · Mio €");
    expect(svg).toContain(`font-size="30" fill="#343a40" text-anchor="start">4,8 Mio €`);
    expect(svg).toContain("+9,1 % ggü. Vorwert");
    expect(svg).toContain("Ziel 5 Mio €");
    expect(svg).toContain(`stroke-dasharray="7 5"`);
    expect(svg).toContain("3,1 Mio €");
    for (const label of ["14.08.", "18.09."]) expect(svg).toContain(label);
  });

  it("omits the target when switched off", () => {
    const svg = businessFallbackSvg("business.trend", trend, { showTarget: false });
    expect(svg).not.toContain("Ziel");
    expect(svg).not.toContain(`stroke-dasharray="7 5"`);
  });

  it("keeps long series readable by thinning time labels", () => {
    const points = Array.from({ length: 24 }, (_, index) => ({ label: `KW ${index + 10}`, value: 100 + index * 3 }));
    const svg = businessFallbackSvg("business.trend", { label: "Pipeline", unit: "T€", points });
    expect(svg).toContain("KW 10");
    expect(svg).toContain("KW 33");
    expect(svg).not.toContain("KW 11<");
  });
});

describe("businessFallbackSvg: invalid data", () => {
  it("renders the explanation instead of throwing", () => {
    const missing = businessFallbackSvg("business.trend", undefined);
    expect(missing).toContain("Die Daten fehlen.");
    const invalid = businessFallbackSvg("business.kpi-bars", { items: [] });
    expect(invalid).toContain("Die Daten sind ungültig");
    expect(invalid).toContain("Szenendaten fehlen oder sind ungültig");
  });

  it("encodes a data URI", () => {
    expect(businessFallbackDataUri("business.kpi-bars", kpis)).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/u);
  });
});
