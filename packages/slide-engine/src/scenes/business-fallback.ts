// Workjet fork delta: deterministic 2D rendering of the business scenes. Used below the
// interactive width, without WebGL, for thumbnails and for static exports. No network, no DOM.
import {
  businessPalette,
  dropOverlappingLabels,
  escapeXml,
  estimateTextWidth,
  kpiBarsLayout,
  parseBusinessSceneData,
  sketchJitter,
  spreadVertically,
  toneColor,
  trendLayout,
  wrapText,
  type BusinessPalette,
} from "./business-common";
import type { BusinessSceneId, KpiBarsData, TrendData } from "./business-data";

export type BusinessFallbackOptions = {
  dark?: boolean | undefined;
  /** Six-digit hex accent from the block or canvas embed. */
  accent?: string | undefined;
  /** Accessible name; defaults to the scene's own title. */
  label?: string | undefined;
  /** Omit the paper rectangle so the host background shows through. */
  transparent?: boolean | undefined;
  /** kpi-bars: draw ghost bars and deltas for previous values (default true). */
  showPrevious?: boolean | undefined;
  /** trend: draw the target line (default true). */
  showTarget?: boolean | undefined;
};

const FONT = `Excalifont, Virgil, 'Learnordie Sketch', 'Comic Sans MS', cursive`;
const HEIGHT = 270;

type Svg = { width: number; height: number; body: string; title: string };

/** SVG markup for a business scene. Invalid or missing data renders the explanatory message. */
export function businessFallbackSvg(
  sceneId: BusinessSceneId,
  data: unknown,
  options: BusinessFallbackOptions = {},
) {
  const palette = businessPalette(options.dark ?? false, options.accent);
  const parsed = parseBusinessSceneData(sceneId, data);
  let svg: Svg;
  if (!parsed.ok) svg = messageSvg(parsed.message, palette);
  else if (sceneId === "business.kpi-bars")
    svg = kpiBarsSvg(parsed.data as KpiBarsData, palette, options.showPrevious ?? true);
  else svg = trendSvg(parsed.data as TrendData, palette, options.showTarget ?? true);
  const name = escapeXml(options.label ?? svg.title);
  const paper = options.transparent
    ? ""
    : `<rect width="${svg.width}" height="${svg.height}" fill="${palette.paper}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svg.width} ${svg.height}" role="img" aria-label="2D-Ersatzansicht: ${name}" font-family="${FONT}" style="color:${palette.ink}">${paper}${svg.body}</svg>`;
}

export function businessFallbackDataUri(
  sceneId: BusinessSceneId,
  data: unknown,
  options: BusinessFallbackOptions = {},
) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(businessFallbackSvg(sceneId, data, options))}`;
}

function n(value: number) {
  return Math.round(value * 10) / 10;
}

function text(
  x: number,
  y: number,
  value: string,
  size: number,
  color: string,
  anchor: "start" | "middle" | "end" = "middle",
) {
  return `<text x="${n(x)}" y="${n(y)}" font-size="${size}" fill="${color}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

/** A rectangle drawn twice with slight deterministic wobble, like Excalidraw's sketch strokes. */
function sketchRect(
  x: number,
  y: number,
  width: number,
  height: number,
  seed: number,
  fill: string,
  stroke: string,
  extra = "",
) {
  const jitter = sketchJitter(seed);
  const outline = (amount: number) => {
    const p = () => jitter() * amount;
    return `M${n(x + p())} ${n(y + p())}L${n(x + width + p())} ${n(y + p())}L${n(x + width + p())} ${n(y + height + p())}L${n(x + p())} ${n(y + height + p())}Z`;
  };
  return (
    `<path d="${outline(0.6)}" fill="${fill}" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round" ${extra}/>` +
    `<path d="${outline(1.1)}" fill="none" stroke="${stroke}" stroke-width="0.8" stroke-opacity="0.4" ${extra}/>`
  );
}

function sketchLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  seed: number,
  stroke: string,
  width = 1.2,
  extra = "",
) {
  const jitter = sketchJitter(seed);
  const midX = (x1 + x2) / 2 + jitter() * 1.2;
  const midY = (y1 + y2) / 2 + jitter() * 1.2;
  return `<path d="M${n(x1)} ${n(y1)}Q${n(midX)} ${n(midY)} ${n(x2)} ${n(y2)}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" ${extra}/>`;
}

function kpiBarsSvg(data: KpiBarsData, palette: BusinessPalette, showPrevious: boolean): Svg {
  const layout = kpiBarsLayout(data);
  const count = layout.items.length;
  const width = Math.max(480, 48 + count * 112);
  const padX = 24;
  const top = 64;
  const bottom = HEIGHT - 58;
  const scale = (bottom - top) / (layout.positiveExtent + layout.negativeExtent);
  const baseline = top + layout.positiveExtent * scale;
  const pitch = (width - padX * 2) / count;
  const barWidth = Math.min(40, pitch * 0.34);
  const withPrevious = showPrevious && layout.hasPrevious;
  let body = "";

  layout.items.forEach((item, index) => {
    const cx = padX + pitch * (index + 0.5);
    const hasGhost = withPrevious && item.previousHeight !== undefined;
    const currentX = hasGhost ? cx + barWidth * 0.32 : cx;
    const barTop = (height: number) => Math.min(baseline, baseline - height * scale);
    if (hasGhost) {
      const h = (item.previousHeight ?? 0) * scale;
      body += sketchRect(
        cx - barWidth * 0.32 - barWidth / 2,
        barTop(item.previousHeight ?? 0),
        barWidth,
        Math.max(1, Math.abs(h)),
        index * 7 + 3,
        palette.ghost,
        palette.muted,
        `stroke-dasharray="4 3"`,
      );
    }
    const h = item.height * scale;
    body += sketchRect(
      currentX - barWidth / 2,
      barTop(item.height),
      barWidth,
      Math.max(1, Math.abs(h)),
      index * 7 + 1,
      palette.accentFill,
      palette.ink,
    );
    const highest = Math.min(
      baseline,
      barTop(item.height),
      hasGhost ? barTop(item.previousHeight ?? 0) : baseline,
    );
    const delta = withPrevious ? item.delta : undefined;
    body += text(currentX, highest - (delta ? 24 : 9), item.valueText, 16, palette.ink);
    if (delta) body += text(currentX, highest - 8, delta.text, 13, toneColor(palette, delta.tone));
    const lines = wrapText(item.label, pitch - 10, 2, (value) => estimateTextWidth(value, 13));
    lines.forEach((line, lineIndex) => {
      body += text(cx, bottom + 22 + lineIndex * 16, line, 13, palette.ink);
    });
  });
  body = sketchLine(padX - 6, baseline, width - padX + 6, baseline, 11, palette.ink, 1.3) + body;
  if (layout.scale === "per-item")
    body += text(width - padX, HEIGHT - 8, "je Kennzahl skaliert", 11, palette.muted, "end");
  return {
    width,
    height: HEIGHT,
    body,
    title: `Kennzahlen: ${data.items.map((item) => item.label).join(", ")}`,
  };
}

function trendSvg(data: TrendData, palette: BusinessPalette, showTarget: boolean): Svg {
  const layout = trendLayout(data);
  const target = showTarget ? layout.target : undefined;
  const x0 = 34;
  const x1 = 318;
  const top = 54;
  const bottom = 212;
  const px = (t: number) => x0 + t * (x1 - x0);
  const py = (y: number) => bottom - y * (bottom - top);
  const right = x1 + 22;
  const rightWidth = Math.max(
    estimateTextWidth(layout.lastText, 30),
    estimateTextWidth(layout.changeText, 12),
    target ? estimateTextWidth(target.text, 12) : 0,
  );
  const width = Math.max(480, Math.ceil(right + rightWidth + 16));
  const points = layout.points;
  const last = points[points.length - 1]!;
  let body = text(
    22,
    30,
    layout.unit ? `${layout.label} · ${layout.unit}` : layout.label,
    14,
    palette.muted,
    "start",
  );

  body += sketchLine(x0 - 6, bottom, x1 + 6, bottom, 5, palette.ink, 1.1, `stroke-opacity="0.55"`);
  for (const point of points) {
    body += `<path d="M${n(px(point.t))} ${n(py(point.y))}V${bottom}" stroke="${palette.line}" stroke-width="1" stroke-dasharray="2 4"/>`;
  }
  if (target) {
    body += `<path d="M${x0} ${n(py(target.y))}H${x1}" stroke="${palette.secondary}" stroke-width="1.6" stroke-dasharray="7 5"/>`;
  }
  const line = points
    .map((point, index) => `${index ? "L" : "M"}${n(px(point.t))} ${n(py(point.y))}`)
    .join("");
  body += `<path d="${line}" fill="none" stroke="${palette.accentInk}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
  points.forEach((point, index) => {
    const isLast = index === points.length - 1;
    body += isLast
      ? `<circle cx="${n(px(point.t))}" cy="${n(py(point.y))}" r="6" fill="${palette.accentFill}" stroke="${palette.ink}" stroke-width="1.4"/>`
      : `<circle cx="${n(px(point.t))}" cy="${n(py(point.y))}" r="3.6" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="1.4"/>`;
  });

  const labelY = (label: { index: number; placement: "above" | "below" }) => {
    const y = py(points[label.index]!.y);
    return label.placement === "above" ? y - 11 : y + 21;
  };
  const kept = dropOverlappingLabels(
    layout.valueLabels,
    (index) => px(points[index]!.t),
    labelY,
    (index) => estimateTextWidth(points[index]!.valueText, 12) + 6,
    15,
  );
  for (const label of kept)
    body += text(
      px(points[label.index]!.t),
      labelY(label),
      points[label.index]!.valueText,
      12,
      palette.ink,
    );

  const spacing = points.length > 1 ? (x1 - x0) / (points.length - 1) : x1 - x0;
  const axisWidth = Math.max(spacing * (points.length > layout.axisLabels.length ? 1.6 : 0.95), 40);
  for (const index of layout.axisLabels) {
    const point = points[index]!;
    const [first] = wrapText(point.label, axisWidth, 1, (value) => estimateTextWidth(value, 11));
    body += text(px(point.t), bottom + 20, first ?? "", 11, palette.muted);
  }

  // Right column: the last value large, the target beside its own height, never overlapping.
  const block = 46;
  const stacked = [{ center: py(last.y) + 6, height: block }];
  if (target) stacked.push({ center: py(target.y), height: 18 });
  const centers = spreadVertically(stacked, 4);
  const shift = Math.min(
    0,
    HEIGHT - 8 - Math.max(...stacked.map((item, index) => (centers[index] ?? 0) + item.height / 2)),
  );
  const lastCenter = (centers[0] ?? 0) + shift;
  body += text(right, lastCenter + 4, layout.lastText, 30, palette.ink, "start");
  body += text(right, lastCenter + 22, layout.changeText, 12, palette.muted, "start");
  if (target)
    body += text(right, (centers[1] ?? 0) + shift + 4, target.text, 12, palette.secondary, "start");
  return { width, height: HEIGHT, body, title: `${data.label}: ${layout.lastText}` };
}

function messageSvg(message: string, palette: BusinessPalette): Svg {
  const width = 480;
  const lines = wrapText(message, width - 64, 5, (value) => estimateTextWidth(value, 14));
  let body = sketchRect(
    20,
    20,
    width - 40,
    HEIGHT - 40,
    3,
    "none",
    palette.line,
    `stroke-dasharray="6 5"`,
  );
  lines.forEach((line, index) => {
    body += text(
      width / 2,
      HEIGHT / 2 - ((lines.length - 1) * 20) / 2 + index * 20 + 5,
      line,
      14,
      palette.muted,
    );
  });
  return { width, height: HEIGHT, body, title: "Szenendaten fehlen oder sind ungültig" };
}
