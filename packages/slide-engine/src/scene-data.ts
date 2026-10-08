// Workjet fork delta: the data rule shared by scene3d blocks and canvas scene3d embeds,
// plus a plain-text summary of business scene data for exports, outlines and meetings.
import {
  BUSINESS_SCENE_DATA_MAX_BYTES,
  businessSceneDataSchemas,
  isBusinessSceneId,
  type BusinessSceneData
} from "./scenes/business-data";

export type Scene3dDataIssueCode = "scene3d.missing_data" | "scene3d.invalid_data" | "scene3d.unexpected_data";

export type Scene3dDataIssue = {
  code: Scene3dDataIssueCode;
  message: string;
  repairHint: string;
  expected?: string;
  received?: string;
};

const utf8 = new TextEncoder();

/** UTF-8 byte length of the JSON serialization, or undefined when `value` has none. */
export function serializedByteLength(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : utf8.encode(json).length;
  } catch {
    return undefined;
  }
}

/**
 * Business scene ids need `data` that parses with `businessSceneDataSchemas[sceneId]` and
 * serializes to at most `BUSINESS_SCENE_DATA_MAX_BYTES`; learnordie (`modell.*`) scenes take none.
 */
export function scene3dDataIssue(sceneId: string, data: unknown): Scene3dDataIssue | null {
  if (!isBusinessSceneId(sceneId)) {
    if (data === undefined) return null;
    return {
      code: "scene3d.unexpected_data",
      message: `Scene "${sceneId}" is a fixed learnordie scene and takes no data.`,
      expected: "no data",
      received: typeof data,
      repairHint: "Remove data from this scene, or choose a business scene id that renders data."
    };
  }
  if (data === undefined) {
    return {
      code: "scene3d.missing_data",
      message: `Scene "${sceneId}" requires data.`,
      expected: `data for ${sceneId}`,
      received: "no data",
      repairHint: `Add data matching the ${sceneId} contract (see businessSceneDataSchemas).`
    };
  }
  const bytes = serializedByteLength(data);
  if (bytes === undefined || bytes > BUSINESS_SCENE_DATA_MAX_BYTES) {
    return {
      code: "scene3d.invalid_data",
      message: bytes === undefined
        ? `Scene "${sceneId}" data is not JSON-serializable.`
        : `Scene "${sceneId}" data has ${bytes} bytes; the limit is ${BUSINESS_SCENE_DATA_MAX_BYTES}.`,
      expected: `<= ${BUSINESS_SCENE_DATA_MAX_BYTES} bytes of JSON`,
      received: bytes === undefined ? "non-JSON value" : `${bytes} bytes`,
      repairHint: "Keep scene data small: fewer items or shorter labels."
    };
  }
  const parsed = businessSceneDataSchemas[sceneId].safeParse(data);
  if (parsed.success) return null;
  const details = parsed.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length ? issue.path.map(String).join(".") : "data"}: ${issue.message}`)
    .join("; ");
  return {
    code: "scene3d.invalid_data",
    message: `Scene "${sceneId}" data does not match its contract: ${details}`,
    expected: `${sceneId} data`,
    received: "invalid data",
    repairHint: `Repair data so it matches the ${sceneId} contract (see businessSceneDataSchemas).`
  };
}

/**
 * One plain line per scene, `KPI: label value (Δ ±x %)`, items joined with " · ".
 * Returns undefined for modell scenes and for data that does not parse.
 */
export function businessSceneSummary(sceneId: string, data: unknown, language = "de"): string | undefined {
  if (!isBusinessSceneId(sceneId)) return undefined;
  const parsed = businessSceneDataSchemas[sceneId].safeParse(data);
  if (!parsed.success) return undefined;
  if (sceneId === "business.kpi-bars") {
    const kpi = parsed.data as BusinessSceneData["business.kpi-bars"];
    return `KPI: ${kpi.items
      .map((item) => kpiValueText(item.label, item.value, item.previous, item.unit ?? kpi.unit, language))
      .join(" · ")}`;
  }
  const trend = parsed.data as BusinessSceneData["business.trend"];
  const last = trend.points[trend.points.length - 1];
  const previous = trend.points[trend.points.length - 2];
  if (!last) return `KPI: ${trend.label}`;
  return `KPI: ${kpiValueText(trend.label, last.value, previous?.value, trend.unit, language)}`;
}

/** `label value unit (Δ ±x %)`; the delta is omitted without a non-zero previous value. */
export function kpiValueText(label: string, value: number, previous: number | undefined, unit: string | undefined, language = "de"): string {
  const amount = `${formatNumber(value, language)}${unit ? ` ${unit}` : ""}`;
  if (previous === undefined || previous === 0) return `${label} ${amount}`;
  const percent = ((value - previous) / Math.abs(previous)) * 100;
  const sign = percent > 0 ? "+" : percent < 0 ? "-" : "±";
  return `${label} ${amount} (Δ ${sign}${formatNumber(Math.abs(percent), language, 1)} %)`;
}

/** Locale-light number formatting that does not depend on the ICU data of the host. */
export function formatNumber(value: number, language = "de", maxFractionDigits = 2): string {
  const german = language.toLowerCase().startsWith("de");
  const [group, decimal] = german ? [".", ","] : [",", "."];
  const rounded = Number(value.toFixed(maxFractionDigits));
  const [integer = "0", fraction] = Math.abs(rounded).toString().split(".");
  const grouped = integer.length > 4 ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, group) : integer;
  return `${rounded < 0 ? "-" : ""}${grouped}${fraction ? `${decimal}${fraction}` : ""}`;
}

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * Static stand-in for a business scene in offline exports: the caption and one text line per
 * KPI on warm paper. Interactive rendering stays with the app's scene renderer.
 */
export function businessSceneSnapshotDataUri(sceneId: string, data: unknown, caption: string, language = "de"): string {
  const summary = businessSceneSummary(sceneId, data, language) ?? sceneId;
  const lines = [caption, ...summary.replace(/^KPI: /, "").split(" · ")].slice(0, 9);
  const text = lines
    .map((line, index) =>
      `<text x="32" y="${56 + index * 34}" font-size="${index === 0 ? 26 : 22}"${index === 0 ? ' font-weight="600"' : ""}>${xml(line.slice(0, 80))}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="${xml(caption)}"><rect width="640" height="360" fill="#fffef8"/><g fill="#243a40" font-family="Excalifont, Virgil, sans-serif">${text}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
