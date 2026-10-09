// Workjet fork delta: pure helpers shared by the business scenes (WebGL, SVG fallback, tests).
// Nothing in here touches three.js or the DOM, so layout decisions stay unit-testable.
import {
  businessSceneDataSchemas,
  type BusinessSceneData,
  type BusinessSceneId,
  type KpiBarsData,
  type TrendData,
} from "./business-data";
import { modellTheme, type ModellTheme } from "./modell-theme";

export type BusinessTone = "better" | "worse" | "neutral";

export type BusinessPalette = ModellTheme & {
  /** Accent as requested for fills (bars, ribbon). */
  accentFill: string;
  /** Accent adjusted to at least 3:1 against the paper, for strokes and text. */
  accentInk: string;
  /** Pale tint of the accent for previous-value ghosts. */
  ghost: string;
  better: string;
  worse: string;
  neutral: string;
};

/** Hand-drawn stack first; the figure's own font family is appended at runtime. */
export const BUSINESS_FONT_STACK = `Excalifont, Virgil, "Learnordie Sketch", "Comic Sans MS", cursive`;

/** Excalidraw's paper/ink palette plus two calm signal colours for improvement and decline. */
export function businessPalette(dark = false, accent?: string): BusinessPalette {
  const base = modellTheme(dark);
  const fill = accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : base.accent;
  return {
    ...base,
    accent: fill,
    accentFill: fill,
    accentInk: ensureContrast(fill, base.paper, 3),
    ghost: mix(fill, base.paper, dark ? 0.72 : 0.82),
    better: dark ? "#8ce99a" : "#2b8a3e",
    worse: dark ? "#ffa8a8" : "#c92a2a",
    neutral: base.muted,
  };
}

export function toneColor(palette: BusinessPalette, tone: BusinessTone) {
  return tone === "better" ? palette.better : tone === "worse" ? palette.worse : palette.neutral;
}

// --- colour math ---------------------------------------------------------------------------

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b]
    .map((part) =>
      Math.round(Math.min(255, Math.max(0, part)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function relativeLuminance(hex: string) {
  const [r, g, b] = channels(hex).map((part) => {
    const c = part / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(a: string, b: string, t: number) {
  const ca = channels(a);
  const cb = channels(b);
  return toHex([
    ca[0] + (cb[0] - ca[0]) * t,
    ca[1] + (cb[1] - ca[1]) * t,
    ca[2] + (cb[2] - ca[2]) * t,
  ]);
}

/** Moves `color` towards black or white (whichever is farther from `background`) until it reaches `ratio`. */
export function ensureContrast(color: string, background: string, ratio: number) {
  const target = relativeLuminance(background) > 0.5 ? "#000000" : "#ffffff";
  for (let step = 0; step <= 10; step++) {
    const candidate = mix(color, target, step / 10);
    if (contrastRatio(candidate, background) >= ratio) return candidate;
  }
  return target;
}

// --- number formatting ---------------------------------------------------------------------

const formatters = new Map<string, Intl.NumberFormat>();

function numberFormat(minimum: number, maximum: number) {
  const key = `${minimum}:${maximum}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("de-DE", {
      minimumFractionDigits: minimum,
      maximumFractionDigits: maximum,
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/** Fewer decimals for larger magnitudes: 18.400 · 23,5 · 4,25. */
export function businessFractionDigits(value: number) {
  const magnitude = Math.abs(value);
  return magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
}

/** German number with typographic minus and an optional unit after a no-break space. */
export function formatBusinessNumber(value: number, unit?: string) {
  const text = numberFormat(0, businessFractionDigits(value)).format(value).replace("-", "−");
  return unit ? `${text} ${unit}` : text;
}

function formatPercent(percent: number) {
  const digits = Math.abs(percent) >= 100 ? 0 : 1;
  return `${numberFormat(digits, digits).format(Math.abs(percent))} %`;
}

// --- KPI bars ------------------------------------------------------------------------------

export type KpiDelta = {
  difference: number;
  /** Relative change against |previous|; null when the previous value is zero. */
  percent: number | null;
  tone: BusinessTone;
  text: string;
};

/** Change against the previous Regeltermin, coloured by whether it is an improvement. */
export function kpiDelta(
  value: number,
  previous: number,
  better: "higher" | "lower" = "higher",
  unit?: string,
): KpiDelta {
  const difference = value - previous;
  const percent = previous === 0 ? null : (difference / Math.abs(previous)) * 100;
  const sign = difference > 0 ? "+" : difference < 0 ? "−" : "±";
  const improved = better === "lower" ? difference < 0 : difference > 0;
  const tone: BusinessTone = difference === 0 ? "neutral" : improved ? "better" : "worse";
  const text =
    percent === null
      ? `${sign}${formatBusinessNumber(Math.abs(difference), unit)}`
      : `${sign}${formatPercent(percent)}`;
  return { difference, percent, tone, text };
}

export type KpiBarLayout = {
  label: string;
  unit: string | undefined;
  better: "higher" | "lower";
  value: number;
  previous: number | undefined;
  /** Normalised current value in [-1, 1]; multiply by the scene's bar height. */
  height: number;
  previousHeight: number | undefined;
  valueText: string;
  previousText: string | undefined;
  delta: KpiDelta | undefined;
  /** Slot centre in world units, centred around 0. */
  x: number;
};

export type KpiBarsLayout = {
  /** "shared": one scale for the whole scene; "per-item": every KPI scaled to its own max. */
  scale: "shared" | "per-item";
  items: KpiBarLayout[];
  pitch: number;
  width: number;
  /** Largest normalised height above (positive) and below (negative) the baseline. */
  positiveExtent: number;
  negativeExtent: number;
  hasPrevious: boolean;
};

export const KPI_SLOT_PITCH = 1.8;

/** Above this magnitude spread a shared scale would flatten the smaller KPIs into slivers. */
export const KPI_SHARED_SCALE_MAX_SPREAD = 20;

export function kpiBarsLayout(data: KpiBarsData, pitch = KPI_SLOT_PITCH): KpiBarsLayout {
  const units = data.items.map((item) => item.unit ?? data.unit ?? "");
  const magnitudes = data.items.map((item) =>
    Math.max(Math.abs(item.value), Math.abs(item.previous ?? 0)),
  );
  const nonZero = magnitudes.filter((magnitude) => magnitude > 0);
  const spread = nonZero.length ? Math.max(...nonZero) / Math.min(...nonZero) : 1;
  const scale =
    new Set(units).size === 1 && spread <= KPI_SHARED_SCALE_MAX_SPREAD ? "shared" : "per-item";
  const sharedMax = Math.max(0, ...magnitudes);
  const count = data.items.length;

  const items = data.items.map((item, index): KpiBarLayout => {
    const unit = units[index] || undefined;
    const better = item.better ?? "higher";
    const max = scale === "shared" ? sharedMax : (magnitudes[index] ?? 0);
    const normalise = (value: number) => (max > 0 ? value / max : 0);
    return {
      label: item.label,
      unit,
      better,
      value: item.value,
      previous: item.previous,
      height: normalise(item.value),
      previousHeight: item.previous === undefined ? undefined : normalise(item.previous),
      valueText: formatBusinessNumber(item.value, unit),
      previousText:
        item.previous === undefined ? undefined : formatBusinessNumber(item.previous, unit),
      delta:
        item.previous === undefined ? undefined : kpiDelta(item.value, item.previous, better, unit),
      x: (index - (count - 1) / 2) * pitch,
    };
  });

  const heights = items.flatMap((item) =>
    item.previousHeight === undefined ? [item.height] : [item.height, item.previousHeight],
  );
  const positiveExtent = Math.max(0, ...heights);
  const negativeExtent = Math.max(0, ...heights.map((height) => -height));
  return {
    scale,
    items,
    pitch,
    width: count * pitch,
    positiveExtent: positiveExtent === 0 && negativeExtent === 0 ? 1 : positiveExtent,
    negativeExtent,
    hasPrevious: items.some((item) => item.previous !== undefined),
  };
}

// --- trend ---------------------------------------------------------------------------------

export type TrendPointLayout = {
  label: string;
  value: number;
  /** Position along the time axis in [0, 1]. */
  t: number;
  /** Position inside the padded value domain in [0, 1]. */
  y: number;
  valueText: string;
};

export type TrendValueLabel = { index: number; placement: "above" | "below" };

export type TrendLayout = {
  label: string;
  unit: string | undefined;
  points: TrendPointLayout[];
  domain: [number, number];
  target: { value: number; y: number; text: string } | undefined;
  maxIndex: number;
  minIndex: number;
  lastText: string;
  /** Change of the last point against the one before, e.g. "+9,1 % ggü. Vorwert". */
  changeText: string;
  /** First/min/max value labels (the last value is shown as the large number). */
  valueLabels: TrendValueLabel[];
  /** Indices whose time label is printed under the axis. */
  axisLabels: number[];
};

/** Value domain with headroom: a little above, more below so a minimum label fits under its point. */
export function trendDomain(values: number[]): [number, number] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const pad = span > 0 ? span * 0.12 : Math.abs(hi) * 0.1 || 1;
  return [lo - pad * 2, hi + pad];
}

/** All time labels when they fit, otherwise first, last and evenly spaced ones in between. */
export function trendAxisLabelIndices(count: number, maxLabels = 7) {
  if (count <= maxLabels) return Array.from({ length: count }, (_, index) => index);
  const step = Math.ceil((count - 1) / (maxLabels - 1));
  const indices: number[] = [];
  for (let index = 0; index < count - 1; index += step) indices.push(index);
  // Keep the last label clear of its predecessor.
  if (count - 1 - (indices[indices.length - 1] ?? 0) < step / 2) indices.pop();
  indices.push(count - 1);
  return indices;
}

export function trendLayout(data: TrendData): TrendLayout {
  const values = data.points.map((point) => point.value);
  const domain = trendDomain(data.target === undefined ? values : [...values, data.target]);
  const [lo, hi] = domain;
  const toY = (value: number) => (value - lo) / (hi - lo);
  const count = data.points.length;
  const points = data.points.map(
    (point, index): TrendPointLayout => ({
      label: point.label,
      value: point.value,
      t: count > 1 ? index / (count - 1) : 0,
      y: toY(point.value),
      valueText: formatBusinessNumber(point.value, data.unit),
    }),
  );
  const maxIndex = values.indexOf(Math.max(...values));
  const minIndex = values.indexOf(Math.min(...values));
  const last = values[count - 1] ?? 0;
  const beforeLast = values[count - 2] ?? last;
  const change = kpiDelta(last, beforeLast, "higher", data.unit);

  const valueLabels: TrendValueLabel[] = [];
  const add = (index: number, placement: TrendValueLabel["placement"]) => {
    if (index === count - 1 || valueLabels.some((label) => label.index === index)) return;
    valueLabels.push({ index, placement });
  };
  const flat = maxIndex === minIndex || Math.max(...values) === Math.min(...values);
  if (!flat) {
    add(maxIndex, "above");
    add(minIndex, "below");
  }
  add(0, !flat && minIndex === 0 ? "below" : "above");

  return {
    label: data.label,
    unit: data.unit,
    points,
    domain,
    target:
      data.target === undefined
        ? undefined
        : {
            value: data.target,
            y: toY(data.target),
            text: `Ziel ${formatBusinessNumber(data.target, data.unit)}`,
          },
    maxIndex,
    minIndex,
    lastText: formatBusinessNumber(last, data.unit),
    changeText: `${change.text} ggü. Vorwert`,
    valueLabels,
    axisLabels: trendAxisLabelIndices(count),
  };
}

/**
 * Drops value labels that would collide. `width(index)` is the label width and `height` the
 * label height, both in the units of `x(index)`/`y(index)`; earlier labels win.
 */
export function dropOverlappingLabels(
  labels: TrendValueLabel[],
  x: (index: number) => number,
  y: (label: TrendValueLabel) => number,
  width: (index: number) => number,
  height: number,
) {
  const kept: TrendValueLabel[] = [];
  for (const label of labels) {
    const collides = kept.some(
      (other) =>
        Math.abs(x(label.index) - x(other.index)) < (width(label.index) + width(other.index)) / 2 &&
        Math.abs(y(label) - y(other)) < height,
    );
    if (!collides) kept.push(label);
  }
  return kept;
}

/**
 * Pushes stacked annotations (each with a desired centre and a height) apart so they do not
 * overlap, keeping their order. Returns the adjusted centres.
 */
export function spreadVertically(items: Array<{ center: number; height: number }>, gap = 0) {
  const order = items
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => a.center - b.center);
  for (let i = 1; i < order.length; i++) {
    const below = order[i - 1]!;
    const current = order[i]!;
    const minimum = below.center + (below.height + current.height) / 2 + gap;
    if (current.center < minimum) current.center = minimum;
  }
  const centers = Array.from({ length: items.length }, () => 0);
  for (const item of order) centers[item.index] = item.center;
  return centers;
}

// --- text ----------------------------------------------------------------------------------

/**
 * Greedy word wrap into at most `maxLines` lines no wider than `maxWidth`; words longer than a
 * line are hyphenated, the last line is shortened with an ellipsis. `measure` returns the width
 * of a string in the same unit.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: (value: string) => number,
) {
  const words = glueShortWords(text.trim().split(/\s+/u).filter(Boolean));
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    let rest = word;
    while (measure(rest) > maxWidth && rest.length > 3) {
      const cut = hyphenationPoint(rest, maxWidth, measure);
      lines.push(`${rest.slice(0, cut)}-`);
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`;
    lines.splice(0, lines.length, ...kept);
  }
  // Glue is a layout decision only; hand back ordinary spaces unless the caller used no-break spaces.
  const restore = text.includes("\u00a0")
    ? (line: string) => line
    : (line: string) => line.replaceAll("\u00a0", " ");
  return lines.map((line) => restore(fitLine(line, maxWidth, measure)));
}

/** Keeps one- and two-letter tokens ("Ø", "im", "&") on the line of the following word. */
function glueShortWords(words: string[]) {
  const glued: string[] = [];
  let pending = "";
  words.forEach((word, index) => {
    if ([...word].length <= 2 && index < words.length - 1) {
      pending += `${word}\u00a0`;
      return;
    }
    glued.push(pending + word);
    pending = "";
  });
  return glued;
}

/**
 * Where to break an over-long word: the widest prefix that fits with a hyphen, moved back to a
 * typical German compound joint ("Bearbeitungs-zeit", "Kunden-zufriedenheit") when one is near.
 */
function hyphenationPoint(word: string, maxWidth: number, measure: (value: string) => number) {
  let end = word.length - 1;
  while (end > 2 && measure(`${word.slice(0, end)}-`) > maxWidth) end--;
  for (let cut = Math.min(end, word.length - 3); cut >= Math.max(4, end - 8); cut--) {
    if (/(?:ungs|heits|keits|ions|ens|ers|en|er)$/u.test(word.slice(0, cut))) return cut;
  }
  return end;
}

function fitLine(line: string, maxWidth: number, measure: (value: string) => number) {
  if (measure(line) <= maxWidth) return line;
  let end = line.length;
  while (end > 1 && measure(`${line.slice(0, end).trimEnd()}…`) > maxWidth) end--;
  return `${line.slice(0, end).trimEnd()}…`;
}

/** Width estimate for the hand-drawn fonts when no canvas is available (SVG fallback). */
export function estimateTextWidth(text: string, fontSize: number) {
  return [...text].length * fontSize * 0.56;
}

// --- data parsing --------------------------------------------------------------------------

export type BusinessSceneDataResult<Id extends BusinessSceneId = BusinessSceneId> =
  | { ok: true; data: BusinessSceneData[Id] }
  | { ok: false; message: string };

const sceneNames: Record<BusinessSceneId, string> = {
  "business.kpi-bars": "Kennzahlen-Szene",
  "business.trend": "Verlaufs-Szene",
};

/** Parses scene data with the fixed contract and explains failures in one German sentence. */
export function parseBusinessSceneData<Id extends BusinessSceneId>(
  sceneId: Id,
  data: unknown,
): BusinessSceneDataResult<Id> {
  const name = sceneNames[sceneId];
  if (data === undefined || data === null) {
    return {
      ok: false,
      message: `Die ${name} „${sceneId}“ kann nicht angezeigt werden: Die Daten fehlen.`,
    };
  }
  const result = businessSceneDataSchemas[sceneId].safeParse(data);
  if (result.success) return { ok: true, data: result.data as BusinessSceneData[Id] };
  const issue = result.error.issues[0];
  const path = issue?.path.length ? `${issue.path.map(String).join(".")}: ` : "";
  return {
    ok: false,
    message: `Die ${name} „${sceneId}“ kann nicht angezeigt werden: Die Daten sind ungültig (${path}${issue?.message ?? "unbekannter Fehler"}).`,
  };
}

export function escapeXml(value: string) {
  return value.replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

/** Small deterministic pseudo-random sequence for hand-drawn wobble (no Math.random). */
export function sketchJitter(seed: number) {
  let state = Math.imul(seed + 1, 2654435761) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967295) * 2 - 1;
  };
}
