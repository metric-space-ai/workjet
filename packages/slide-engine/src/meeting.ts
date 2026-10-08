// Workjet fork delta: compact read models of a SlideDocument for agents (outline) and for the
// Jour fixe meeting surface (one readable markdown body and narration per slide).
import type { SlideBlock, SlideDocument, SlideNode } from "./schema";
import { businessSceneSummary, kpiValueText } from "./scene-data";

export const MEETING_SLIDE_TITLE_MAX_CHARS = 256;
export const MEETING_SLIDE_TEXT_MAX_BYTES = 4096;

export type SlideDocumentOutline = {
  id: string;
  title: string;
  language: string;
  theme: SlideDocument["theme"];
  slides: Array<{
    id: string;
    title: string;
    layout: SlideNode["layout"];
    intent: SlideNode["intent"];
    hasCanvas: boolean;
    blockTypes: Array<SlideBlock["type"]>;
    scenes: Array<{ sceneId: string; hasData: boolean }>;
    speakerNotes: number;
    sourceRefs: number;
  }>;
};

export type MeetingSlide = {
  id: string;
  position: number;
  title: string;
  body_markdown: string;
  narration: string;
};

/** Slide-by-slide structure without content, small enough to keep in an agent's context. */
export function slideDocumentOutline(document: SlideDocument): SlideDocumentOutline {
  return {
    id: document.id,
    title: document.title,
    language: document.language,
    theme: document.theme,
    slides: document.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      layout: slide.layout,
      intent: slide.intent,
      hasCanvas: slide.canvas !== undefined,
      blockTypes: slide.blocks.map((block) => block.type),
      scenes: slideScenes(slide),
      speakerNotes: slide.speakerNotes?.length ?? 0,
      sourceRefs: slide.sourceRefs.length
    }))
  };
}

/**
 * Meeting projection of every slide. The body comes from the native canvas text when the slide
 * has a canvas (it is authoritative), otherwise from the blocks. Narration is the talking-point
 * speaker notes, or the body as plain text when there are none.
 */
export function meetingSlides(document: SlideDocument): MeetingSlide[] {
  return document.slides.map((slide, index) => {
    const title = truncateChars(slide.title.trim(), MEETING_SLIDE_TITLE_MAX_CHARS);
    const parts = slide.canvas ? canvasMarkdownParts(slide, document.language) : blockMarkdownParts(slide, document.language);
    const body = truncateUtf8(parts.filter((part) => part.trim()).join("\n\n").trim(), MEETING_SLIDE_TEXT_MAX_BYTES) || title;
    const notes = (slide.speakerNotes ?? [])
      .filter((note) => note.kind === undefined || note.kind === "talkingPoint")
      .map((note) => note.text.trim())
      .filter(Boolean);
    const narration = truncateUtf8(notes.length ? notes.join("\n\n") : plainText(body), MEETING_SLIDE_TEXT_MAX_BYTES) || title;
    return { id: slide.id, position: index + 1, title, body_markdown: body, narration };
  });
}

function slideScenes(slide: SlideNode): Array<{ sceneId: string; hasData: boolean }> {
  if (slide.canvas) {
    return slide.canvas.elements.flatMap((element) => {
      const embed = element.customData?.learnordie;
      return !element.isDeleted && embed?.type === "scene3d" ? [{ sceneId: embed.sceneId, hasData: embed.data !== undefined }] : [];
    });
  }
  return slide.blocks.flatMap((block) => (block.type === "scene3d" ? [{ sceneId: block.sceneId, hasData: block.data !== undefined }] : []));
}

function canvasMarkdownParts(slide: SlideNode, language: string): string[] {
  const parts: Array<{ x: number; y: number; text: string }> = [];
  for (const element of slide.canvas?.elements ?? []) {
    if (element.isDeleted || element.id === `${slide.id}:title`) continue;
    if (element.type === "text") {
      const text = (element.originalText ?? element.text ?? "").trim();
      if (text) parts.push({ x: element.x, y: element.y, text: text.replace(/^• /gm, "- ") });
      continue;
    }
    const embed = element.customData?.learnordie;
    if (element.type !== "embeddable" || !embed) continue;
    const text = embed.type === "html" ? embed.title : (businessSceneSummary(embed.sceneId, embed.data, language) ?? embed.caption);
    if (text?.trim()) parts.push({ x: element.x, y: element.y, text: text.trim() });
  }
  return parts.sort((a, b) => a.y - b.y || a.x - b.x).map((part) => part.text);
}

function blockMarkdownParts(slide: SlideNode, language: string): string[] {
  return slide.blocks
    .filter((block) => !(block.type === "heading" && block.text.trim() === slide.title.trim()))
    .map((block) => blockMarkdown(block, language));
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
const quoted = (value: string) => value.split("\n").map((line) => `> ${line}`).join("\n");
const german = (language: string) => language.toLowerCase().startsWith("de");

function blockMarkdown(block: SlideBlock, language: string): string {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(Math.min(6, (block.level ?? 1) + 1))} ${oneLine(block.text)}`;
    case "paragraph":
      return block.text;
    case "bulletList":
      return block.items.map((item) => `- ${oneLine(item)}`).join("\n");
    case "numberedList":
      return block.items.map((item, index) => `${index + 1}. ${oneLine(item)}`).join("\n");
    case "definition":
      return [`**${oneLine(block.term)}**: ${block.definition}`, block.example && `${german(language) ? "Beispiel" : "Example"}: ${block.example}`]
        .filter(Boolean)
        .join("\n\n");
    case "callout":
      return quoted([block.title && `**${oneLine(block.title)}**`, block.text].filter(Boolean).join(" "));
    case "figure":
      return block.caption ?? block.altText;
    case "formula":
      return [block.latex ? `$$${block.latex}$$` : undefined, block.caption].filter(Boolean).join("\n\n");
    case "table":
      return markdownTable(block);
    case "chart":
      return chartLine(block, language);
    case "process":
      return block.steps.map((step, index) => `${index + 1}. **${oneLine(step.title)}**${step.text ? ` ${oneLine(step.text)}` : ""}`).join("\n");
    case "comparison":
      return [block.left, block.right]
        .map((side) => [`**${oneLine(side.title)}**`, side.body, ...(side.items ?? []).map((item) => `- ${oneLine(item)}`)].filter(Boolean).join("\n"))
        .join("\n\n");
    case "code":
      return `\`\`\`${block.language}\n${block.code}\n\`\`\``;
    case "quote":
      return quoted([block.text, block.attribution && `— ${block.attribution}`].filter(Boolean).join("\n"));
    case "quizAnchor":
      return block.prompt ?? "";
    case "spacer":
      return "";
    case "scene3d":
      return businessSceneSummary(block.sceneId, block.data, language) ?? block.caption ?? block.altText;
  }
}

function markdownTable(block: Extract<SlideBlock, { type: "table" }>): string {
  const cell = (value: string | undefined) => oneLine(value ?? "").replaceAll("|", "\\|") || " ";
  const row = (cells: Array<string | undefined>) => `| ${cells.map(cell).join(" | ")} |`;
  const table = [
    row(block.columns),
    `| ${block.columns.map(() => "---").join(" | ")} |`,
    ...block.rows.map((cells) => row(block.columns.map((_, index) => cells[index])))
  ].join("\n");
  return block.caption ? `${block.caption}\n\n${table}` : table;
}

function chartLine(block: Extract<SlideBlock, { type: "chart" }>, language: string): string {
  const label = oneLine(block.title ?? block.caption ?? (german(language) ? "Diagramm" : "Chart"));
  const values = Array.isArray(block.data?.values) ? block.data.values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)) : [];
  const last = values[values.length - 1];
  if (last === undefined) return `KPI: ${label}`;
  return `KPI: ${kpiValueText(label, last, values[values.length - 2], undefined, language)}`;
}

/** Markdown reduced to readable plain text for narration. */
export function plainText(markdown: string): string {
  return markdown
    .split("\n")
    .flatMap((line) => {
      if (/^\s*```/.test(line) || /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) return [];
      let text = line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\$\$(.+?)\$\$/g, "$1");
      if (/^\s*\|.*\|\s*$/.test(text)) {
        text = text
          .trim()
          .slice(1, -1)
          .split(/(?<!\\)\|/)
          .map((cell) => cell.trim().replaceAll("\\|", "|"))
          .join(", ");
      }
      return [text];
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const utf8 = new TextEncoder();

/** At most `maxBytes` UTF-8 bytes, cut on a code point boundary and marked with "…". */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8.encode(text).length <= maxBytes) return text;
  const budget = maxBytes - utf8.encode("…").length;
  let bytes = 0;
  let kept = "";
  for (const char of text) {
    const size = utf8.encode(char).length;
    if (bytes + size > budget) break;
    kept += char;
    bytes += size;
  }
  return `${kept.trimEnd()}…`;
}

function truncateChars(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join("").trimEnd()}…`;
}
