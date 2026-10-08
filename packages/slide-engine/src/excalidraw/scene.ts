import { parseSlideDocument, type SlideAssetRef, type SlideBlock, type SlideDocument, type SlideNode } from "../schema";
import { CANVAS_VERSION, CANVAS_WIDTH, CANVAS_HEIGHT, canvasSceneSchema, isSafeCanvasImage, type CanvasElement, type CanvasScene } from "./canvas-schema";

const INK = "#243a40";
const ACCENT = "#197c70";
const PAPER = "#fffef8";

function seedFor(id: string): number {
  let seed = 2166136261;
  for (const char of id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return (seed >>> 0) % 2147483647;
}

function base(id: string, type: CanvasElement["type"], x: number, y: number, width: number, height: number, sourceBlockId?: string): CanvasElement {
  return {
    id, type, x, y, width, height, angle: 0, strokeColor: INK, backgroundColor: "transparent",
    fillStyle: "hachure", strokeWidth: 2, strokeStyle: "solid", roughness: 1,
    opacity: 100, groupIds: sourceBlockId ? [`group:${sourceBlockId}`] : [], frameId: null,
    index: null, roundness: null, seed: seedFor(id), version: 1, versionNonce: seedFor(`${id}:version`),
    isDeleted: false, boundElements: null, updated: 0, link: null, locked: false,
    ...(sourceBlockId ? { customData: { sourceBlockId } } : {})
  };
}

function wrap(text: string, width: number, fontSize: number): string {
  const chars = Math.max(3, Math.floor(width / (fontSize * 0.58)));
  return text.split("\n").flatMap((line) => {
    const lines: string[] = [];
    let rest = line;
    while (rest.length > chars) {
      const space = rest.lastIndexOf(" ", chars);
      const split = space > chars / 3 ? space : chars;
      lines.push(rest.slice(0, split));
      rest = rest.slice(split + (rest[split] === " " ? 1 : 0));
    }
    lines.push(rest);
    return lines;
  }).join("\n");
}

function textElement(id: string, text: string, x: number, y: number, width: number, fontSize: number, sourceBlockId?: string, mono = false): CanvasElement {
  const wrapped = wrap(text, width, fontSize);
  return {
    ...base(id, "text", x, y, width, wrapped.split("\n").length * fontSize * 1.3, sourceBlockId),
    text: wrapped, originalText: text, fontSize, fontFamily: mono ? 3 : 1,
    textAlign: "left", verticalAlign: "top", containerId: null, autoResize: false, lineHeight: 1.3
  };
}

function readable(block: SlideBlock): string {
  switch (block.type) {
    case "heading": case "paragraph": return block.text;
    case "bulletList": return block.items.map((item) => `• ${item}`).join("\n");
    case "numberedList": return block.items.map((item, i) => `${i + 1}. ${item}`).join("\n");
    case "definition": return [block.term, block.definition, block.example && `Beispiel: ${block.example}`].filter(Boolean).join("\n\n");
    case "callout": return [block.title, block.text].filter(Boolean).join("\n");
    case "formula": return [block.latex ?? block.mathMl, block.caption].filter(Boolean).join("\n");
    case "quote": return [`„${block.text}“`, block.attribution].filter(Boolean).join("\n");
    case "code": return [block.code, block.caption].filter(Boolean).join("\n");
    case "quizAnchor": return block.prompt ?? `Frage · ${block.level}`;
    case "chart": return [block.title, block.data && JSON.stringify(block.data, null, 2), block.caption].filter(Boolean).join("\n");
    case "figure": return [block.altText, block.caption].filter(Boolean).join("\n");
    case "scene3d": return block.caption ?? block.altText;
    case "spacer": return "";
    case "table": return [block.columns, ...block.rows].map((row) => row.join(" | ")).join("\n");
    case "process": return block.steps.map((step, i) => `${i + 1}. ${step.title}\n${step.text ?? ""}`).join("\n");
    case "comparison": return [block.left, block.right].map((side) => [side.title, side.body, ...(side.items ?? [])].filter(Boolean).join("\n")).join("\n\n");
  }
}

function blockElements(block: SlideBlock, x: number, y: number, width: number, files: CanvasScene["files"], assets: SlideAssetRef[]): CanvasElement[] {
  const id = (part: string) => `${block.id}:${part}`;
  if (block.type === "spacer") return [];
  if (block.type === "scene3d") return [{
    ...base(id("scene"), "embeddable", x, y, width, Math.min(430, width * 0.65), block.id),
    link: `https://learnordie.invalid/embed/${encodeURIComponent(id("scene"))}`,
    customData: { sourceBlockId: block.id, learnordie: { type: "scene3d", sceneId: block.sceneId, ...(block.caption ? { caption: block.caption } : {}), ...(block.accent ? { accent: block.accent } : {}) } }
  }];
  if (block.type === "figure" || (block.type === "chart" && block.assetId)) {
    const asset = assets.find((item) => item.id === block.assetId);
    if (asset?.url && isSafeCanvasImage(asset.url)) {
      const fileId = `asset:${asset.id}`;
      files[fileId] = { id: fileId, dataURL: asset.url, mimeType: asset.url.slice(5, asset.url.indexOf(";")) as CanvasScene["files"][string]["mimeType"], created: 0 };
      const height = Math.min(400, width * 0.6);
      return [{ ...base(id("image"), "image", x, y, width, height, block.id), fileId, status: "saved", scale: [1, 1], crop: null }, textElement(id("caption"), block.caption ?? asset.altText ?? asset.title, x, y + height + 12, width, 23, block.id)];
    }
    if (block.assetId?.startsWith("legacy-diagram-")) {
      const caption = textElement(id("caption"), block.caption ?? asset?.title ?? "Diagramm", x, y + 310, width, 24, block.id);
      if (block.assetId.endsWith("bearing")) return [
        { ...base(id("shell"), "ellipse", x + width * 0.18, y, 290, 290, block.id), backgroundColor: "#c9e6df" },
        { ...base(id("shaft"), "ellipse", x + width * 0.18 + 48, y + 55, 185, 185, block.id), backgroundColor: "#fff3bf" },
        textElement(id("label"), "Welle · Schmierfilm · Lagerschale", x, y + 265, width, 21, block.id), caption
      ];
      if (block.assetId.endsWith("ramp")) return [
        { ...base(id("axes"), "line", x + 30, y + 10, width - 60, 260, block.id), points: [[0, 0], [0, 260], [width - 60, 260]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null },
        { ...base(id("ramp"), "line", x + 30, y + 35, width - 80, 230, block.id), strokeColor: ACCENT, points: [[0, 230], [width * 0.45, 25], [width - 80, 0]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null }, caption
      ];
      return [textElement(id("formula"), "So = (η · n / p) · (r / c)²", x, y + 70, width, 36, block.id), caption];
    }
    // Pure conversion never fetches remote content. Reserve native image geometry
    // and a stable asset ID so the client can hydrate approved rasters to files.
    // A visible pending-import caption avoids silently substituting description.
    const height = Math.min(400, width * 0.6);
    return [
      { ...base(id("asset"), "rectangle", x, y, width, height, block.id), strokeStyle: "dashed", backgroundColor: "#f1eee4", fillStyle: "solid", customData: { sourceBlockId: block.id, sourceAssetId: block.assetId!, assetPlaceholder: true } },
      textElement(id("caption"), ["Bildimport ausstehend", readable(block), asset?.description].filter(Boolean).join("\n"), x, y + height + 12, width, 25, block.id)
    ];
  }
  if (block.type === "table") {
    const result: CanvasElement[] = [];
    let rowY = y;
    const cellWidth = width / block.columns.length;
    for (const [rowIndex, row] of [block.columns, ...block.rows].entries()) {
      const labels = row.map((cell, col) => textElement(id(`r${rowIndex}c${col}`), cell, x + col * cellWidth + 12, rowY + 10, cellWidth - 24, 24, block.id));
      const height = Math.max(52, ...labels.map((label) => label.height + 20));
      row.forEach((_, col) => result.push({ ...base(id(`cell${rowIndex}-${col}`), "rectangle", x + col * cellWidth, rowY, cellWidth, height, block.id), backgroundColor: rowIndex === 0 ? "#c9e6df" : "transparent", fillStyle: "solid", roughness: 0.5 }));
      result.push(...labels);
      rowY += height;
    }
    if (block.caption) result.push(textElement(id("caption"), block.caption, x, rowY + 12, width, 23, block.id));
    return result;
  }
  if (block.type === "chart" && ["bar", "line", "scatter"].includes(block.chartType) && Array.isArray(block.data?.labels) && Array.isArray(block.data?.values)) {
    const labels = block.data.labels;
    const values = block.data.values;
    if (labels.length > 0 && labels.length <= 30 && labels.length === values.length && labels.every((label) => typeof label === "string") && values.every((value) => typeof value === "number" && Number.isFinite(value))) {
      const numbers = values as number[];
      const minimum = Math.min(0, ...numbers);
      const maximum = Math.max(0, ...numbers);
      const range = maximum - minimum || 1;
      const cellWidth = width / numbers.length;
      const baseline = y + 55 + maximum / range * 260;
      const points: Array<[number, number]> = numbers.map((value, i) => [cellWidth * (i + 0.5), 55 + (maximum - value) / range * 260]);
      const result: CanvasElement[] = [textElement(id("title"), block.title ?? "Diagramm", x, y, width, 30, block.id)];
      result.push({ ...base(id("axis"), "line", x, baseline, width, 0, block.id), points: [[0, 0], [width, 0]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null });
      if (block.chartType === "line") result.push({ ...base(id("curve"), "line", x, y, width, 315, block.id), strokeColor: ACCENT, points, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null });
      numbers.forEach((value, i) => {
        const valueY = y + points[i][1];
        if (block.chartType === "bar") result.push({ ...base(id(`bar${i}`), "rectangle", x + cellWidth * (i + 0.2), Math.min(valueY, baseline), cellWidth * 0.6, Math.abs(valueY - baseline), block.id), backgroundColor: "#c9e6df", fillStyle: "hachure" });
        else result.push({ ...base(id(`point${i}`), "ellipse", x + points[i][0] - 5, valueY - 5, 10, 10, block.id), backgroundColor: ACCENT, fillStyle: "solid" });
        result.push(textElement(id(`label${i}`), `${labels[i]}\n${value}`, x + cellWidth * i + 4, y + 335, cellWidth - 8, 22, block.id));
      });
      if (block.caption) result.push(textElement(id("caption"), block.caption, x, Math.max(...result.map((e) => e.y + e.height)) + 12, width, 22, block.id));
      return result;
    }
  }
  if (block.type === "process") {
    const result: CanvasElement[] = [];
    let stepY = y;
    block.steps.forEach((step, i) => {
      const text = textElement(id(`step${i}`), `${i + 1}. ${step.title}${step.text ? `\n${step.text}` : ""}`, x + 24, stepY + 18, width - 48, 28, block.id);
      result.push({ ...base(id(`box${i}`), "rectangle", x, stepY, width, text.height + 36, block.id), backgroundColor: i % 2 ? "#fff3bf" : "#e3f0da", fillStyle: "solid", roundness: { type: 3 } }, text);
      stepY += text.height + 60;
      if (i < block.steps.length - 1) result.push({ ...base(id(`arrow${i}`), "arrow", x + width / 2, stepY - 24, 0, 24, block.id), points: [[0, 0], [0, 24]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: "arrow", elbowed: false });
    });
    return result;
  }
  if (block.type === "comparison") return [block.left, block.right].flatMap((side, i) => {
    const label = textElement(id(`side${i}`), [side.title, side.body, ...(side.items ?? []).map((item) => `• ${item}`)].filter(Boolean).join("\n\n"), x + i * (width / 2 + 12) + 20, y + 20, width / 2 - 54, 28, block.id);
    return [{ ...base(id(`panel${i}`), "rectangle", x + i * (width / 2 + 12), y, width / 2 - 12, label.height + 40, block.id), backgroundColor: i ? "#fff3bf" : "#c9e6df", fillStyle: "solid", roundness: { type: 3 } }, label];
  });
  const text = textElement(id("text"), readable(block), x, y, width, block.type === "heading" ? 38 : 30, block.id, block.type === "code" || block.type === "formula");
  if (block.type === "callout" || block.type === "definition") {
    text.x += 24; text.y += 20; text.width -= 48;
    return [{ ...base(id("panel"), "rectangle", x, y, width, text.height + 40, block.id), backgroundColor: block.type === "callout" && block.tone === "warning" ? "#ffe3dc" : "#e3f0da", fillStyle: "solid", roundness: { type: 3 } }, text];
  }
  return [text];
}

/** Pure deterministic migration; existing native scenes are authoritative. */
export function canvasSceneForSlide(slide: SlideNode, assets: SlideAssetRef[] = []): CanvasScene {
  if (slide.canvas) return canvasSceneSchema.parse(slide.canvas);
  const files: CanvasScene["files"] = {};
  const heading = slide.blocks.find((block) => block.type === "heading" && block.text === slide.title);
  const elements = [textElement(`${slide.id}:title`, slide.title, 88, 80, 1424, 54, heading?.id)];
  const bodyTop = Math.max(230, elements[0].y + elements[0].height + 70);
  elements.push({ ...base(`${slide.id}:underline`, "line", 90, bodyTop - 50, 300, 0), strokeColor: ACCENT, points: [[0, 0], [300, 0]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null });
  const content = slide.blocks.filter((block) => block !== heading);
  const visual = /figure_(right|left)/.test(slide.layout) ? content.find((block) => block.type === "figure" || block.type === "scene3d") : undefined;
  const leftVisual = slide.layout === "technical_figure_left";
  const body: CanvasElement[] = [];
  let y = bodyTop;
  for (const block of content.filter((item) => item !== visual)) {
    const next = blockElements(block, visual && leftVisual ? 810 : 88, y, visual ? 660 : 1424, files, assets);
    body.push(...next);
    y = Math.max(y + (block.type === "spacer" ? 30 : 0), ...next.map((item) => item.y + item.height)) + 28;
  }
  if (visual) body.push(...blockElements(visual, leftVisual ? 88 : 810, bodyTop + 10, 660, files, assets));
  const bottom = Math.max(bodyTop, ...body.map((item) => item.y + item.height));
  const scale = Math.min(1, (830 - bodyTop) / (bottom - bodyTop || 1));
  for (const item of body) {
    item.x = 88 + (item.x - 88) * scale;
    item.y = bodyTop + (item.y - bodyTop) * scale;
    item.width *= scale; item.height *= scale;
    if (typeof item.fontSize === "number") item.fontSize *= scale;
    if (item.points) item.points = item.points.map(([px, py]) => [px * scale, py * scale]);
  }
  return canvasSceneSchema.parse({ version: CANVAS_VERSION, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, backgroundColor: PAPER, elements: [...elements, ...body], files });
}

/** Replace only the canvas; retain stable slide/block IDs, provenance and quiz anchors. */
export function updateSlideCanvas(document: SlideDocument, slideId: string, scene: CanvasScene): SlideDocument {
  const canvas = canvasSceneSchema.parse(scene);
  if (!document.slides.some((slide) => slide.id === slideId)) throw new Error(`Slide ${slideId} does not exist.`);
  return parseSlideDocument({ ...document, slides: document.slides.map((slide) => {
    if (slide.id !== slideId) return slide;
    const next = { ...slide, canvas };
    const titleElement = canvas.elements.find((item) => item.id === `${slide.id}:title` && item.type === "text" && !item.isDeleted);
    const title = (titleElement?.originalText ?? titleElement?.text)?.trim();
    if (title) next.title = title.slice(0, 140);
    // Semantic blocks are bounded projections for search/quiz context. Native
    // canvas text remains complete even when it exceeds a legacy block budget.
    next.blocks = slide.blocks.map((block) => {
      if (block.type !== "heading" && block.type !== "paragraph") return block;
      const text = canvasTextForBlock(next, block.id)?.trim();
      if (!text) return block; // Keep stable metadata/anchor targets for deleted text.
      return { ...block, text: text.slice(0, block.type === "heading" ? 140 : 1200) };
    });
    return next;
  }) });
}

/** Legacy text exports are projections, not a path to reconstruct a native scene. */
export function canvasTextForBlock(slide: SlideNode, blockId: string): string | undefined {
  if (!slide.canvas) return undefined;
  const text = slide.canvas.elements.filter((item) => !item.isDeleted && item.type === "text" && item.customData?.sourceBlockId === blockId);
  return text.map((item) => item.originalText ?? item.text ?? "").join("\n");
}
