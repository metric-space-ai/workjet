// QA page for the business scenes: realistic Jour fixe data at slide and thumbnail size.
// Bundled by qa/build-scenes-qa.mjs into qa/dist/scenes-qa.js (gitignored).
import { createRoot } from "react-dom/client";

import {
  Scene3DBlockRenderer,
  type Scene3DRendererBlock,
} from "../src/components/Scene3DBlockRenderer";

type QaCase = {
  id: string;
  title: string;
  width: number;
  height: number;
  block: Scene3DRendererBlock;
  business: boolean;
};

const jourFixeKpis = {
  items: [
    { label: "Umsatz MRR", value: 18400, previous: 16900, unit: "€" },
    { label: "Aktive Nutzer", value: 1240, previous: 1310 },
    { label: "Gemergte PRs", value: 23, previous: 17 },
    { label: "Offene Bugs", value: 9, previous: 14, better: "lower" },
  ],
};

const exitValue = {
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

const edgeKpis = {
  unit: "T€",
  items: [
    { label: "Cashflow operativ", value: -42, previous: 18 },
    {
      label: "Ø Bearbeitungszeit offener Kundentickets",
      value: 31.5,
      previous: 44,
      unit: "h",
      better: "lower",
    },
    { label: "Pipeline", value: 1280, previous: 1150 },
    { label: "Neue Leads", value: 64, unit: "Leads" },
    { label: "Churn", value: 2.4, previous: 2.4, unit: "%", better: "lower" },
    { label: "NPS", value: 41, previous: 38, unit: "Pkt." },
    { label: "Deployments", value: 12, previous: 0, unit: "×" },
    { label: "Serverkosten", value: 3.8, previous: 4.1, better: "lower" },
  ],
};

const longTrend = {
  label: "Pipeline gewichtet",
  unit: "T€",
  points: Array.from({ length: 24 }, (_, index) => ({
    label: `KW ${index + 14}`,
    value: Math.round((620 + index * 18 + Math.sin(index * 0.9) * 70) * 10) / 10,
  })),
};

const block = (
  id: string,
  sceneId: string,
  altText: string,
  extra: Partial<Scene3DRendererBlock> = {},
): Scene3DRendererBlock => ({
  id,
  type: "scene3d",
  sceneId,
  altText,
  ...extra,
});

const kpiBlock = block("kpi", "business.kpi-bars", "Kennzahlen gegenüber dem letzten Jour fixe", {
  data: jourFixeKpis,
});
const trendBlock = block(
  "trend",
  "business.trend",
  "Exitwert E5 über die letzten sechs Regeltermine",
  { data: exitValue },
);

const cases: QaCase[] = [
  {
    id: "kpi-960",
    title: "business.kpi-bars · 960×540",
    width: 960,
    height: 540,
    block: kpiBlock,
    business: true,
  },
  {
    id: "kpi-260",
    title: "business.kpi-bars · 260×146 (Ersatzansicht)",
    width: 260,
    height: 146,
    block: kpiBlock,
    business: true,
  },
  {
    id: "trend-960",
    title: "business.trend · 960×540",
    width: 960,
    height: 540,
    block: trendBlock,
    business: true,
  },
  {
    id: "trend-260",
    title: "business.trend · 260×146 (Ersatzansicht)",
    width: 260,
    height: 146,
    block: trendBlock,
    business: true,
  },
  {
    id: "kpi-edge-960",
    title: "business.kpi-bars · 8 Kennzahlen, lange Namen, negativ, ohne Vorwert, Akzent",
    width: 960,
    height: 540,
    block: block("kpi-edge", "business.kpi-bars", "Acht Kennzahlen mit Randfällen", {
      data: edgeKpis,
      accent: "#8fcfc2",
    }),
    business: true,
  },
  {
    id: "trend-long-960",
    title: "business.trend · 24 Punkte, ohne Ziel, Akzent",
    width: 960,
    height: 540,
    block: block("trend-long", "business.trend", "Gewichtete Pipeline über 24 Wochen", {
      data: longTrend,
      accent: "#e5c48c",
    }),
    business: true,
  },
  {
    id: "invalid-960",
    title: "business.kpi-bars · ungültige Daten",
    width: 960,
    height: 300,
    block: block("invalid", "business.kpi-bars", "Ungültige Kennzahlen", { data: { items: [] } }),
    business: true,
  },
  {
    id: "missing-960",
    title: "business.trend · fehlende Daten",
    width: 960,
    height: 300,
    block: block("missing", "business.trend", "Verlauf ohne Daten"),
    business: true,
  },
  {
    id: "modell-law-960",
    title: "modell.law · Regression (unverändert)",
    width: 960,
    height: 540,
    block: block("law", "modell.law", "Hängende Feder mit Zeitverlauf"),
    business: false,
  },
];

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const onlyBusiness = params.get("only") === "business";
const visible = cases.filter((entry) => !onlyBusiness || entry.business);

function QaPage() {
  return (
    <main>
      <h1>Business-Szenen · {document.documentElement.dataset.theme}</h1>
      {visible.map((entry) => (
        <section className="qa-case" data-case={entry.id} key={entry.id}>
          <h2>{entry.title}</h2>
          <div className="qa-frame" style={{ width: entry.width, height: entry.height }}>
            <div className="qa-canvas-scene">
              <Scene3DBlockRenderer block={entry.block} />
            </div>
          </div>
        </section>
      ))}
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<QaPage />);
