// Workjet fork delta: content rules for Jour fixe meeting decks written by an agent. A meeting
// deck speaks to the Owner about the project, so wording about the slide itself, internal ids
// and slides that only say "no data" are repairable errors. Lecture decks are not linted.
import type { SlideBlock, SlideDocument, SlideDocumentValidationIssue, SlideNode } from "./schema";
import { businessSceneSummary, formatNumber } from "./scene-data";

export type MeetingLintCode =
  | "content.title_repeated"
  | "content.meta_phrase"
  | "content.system_jargon"
  | "content.empty_slide"
  | "content.placeholder_table"
  | "content.duplicate_text"
  | "narration.missing"
  | "narration.too_long"
  | "narration.unsupported_number"
  | "narration.reads_slide";

/** Narration budget: the meeting voice speaks about 15.6 characters per second. */
export const NARRATION_MAX_CHARS = 450;
export const TITLE_NARRATION_MAX_CHARS = 150;

type Segment = {
  slideId: string;
  blockId?: string;
  pathSegments: Array<string | number>;
  text: string;
};

// Wording about the slide, the deck, the display or the data plumbing instead of the project.
// German first (meeting decks are German), English for decks written in English.
const META_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:diese[rsnm]?|auf dieser|in dieser|nächsten?|vorigen?|vorherigen?) Folie\b/iu, "the slide"],
  [/\bFolie (?:zeigt|enthält|bleibt|fasst|stellt)\b/iu, "the slide"],
  [/\b(?:alle|allen) Folien\b/iu, "the slides"],
  [/\bbleib(?:t|en) (?:\p{L}+ ){0,3}leer\b/iu, "an empty display"],
  [/\berscheint (?:\p{L}+ ){0,2}(?:hier|an dieser Stelle)\b/iu, "where something appears"],
  [
    /\bhier (?:erscheint|erscheinen|steht|stehen|sehen Sie|sieht man|zeige ich|zeigen wir)\b/iu,
    "the display",
  ],
  [/\b(?:links|rechts|oben|unten) (?:steht|stehen|sehen Sie|sieht man|zeigt)\b/iu, "the layout"],
  [/\blaut (?:KPI-)?(?:Katalog|Konfiguration)\b/iu, "the data plumbing"],
  [/\baus der (?:Projekt-?)?Konfiguration\b/iu, "the data plumbing"],
  [/\b(?:frühere|vorherige|keine) Präsentation\b/iu, "the presentation system"],
  [/\b(?:ich|wir) (?:zeige|zeigen|erfinde|erfinden|stelle|stellen) /iu, "the author's own choices"],
  [/\bwird (?:hier |unten |oben )?(?:angezeigt|dargestellt|visualisiert)\b/iu, "the display"],
  [
    /\b(?:Trenddarstellung|Darstellung|Anzeige|Visualisierung) (?:bleibt|entfällt|fehlt)\b/iu,
    "the display",
  ],
  [
    /\b(?:Vorschläge|Vorschlag|Details|Konkretes) folg(?:en|t) (?:am Ende|später|im Anschluss)\b/iu,
    "the meeting process",
  ],
  [/\bIm Folgenden\b/u, "the presentation itself"],
  [/\bwie Sie (?:hier |oben |unten )?sehen\b/iu, "the display"],
  [/\b(?:this|the next|the previous) slide\b/iu, "the slide"],
  [/\b(?:shown|displayed|appears?) here\b/iu, "the display"],
  [/\bstays? empty\b/iu, "an empty display"],
];

// Internal ids and system terms that mean nothing to the Owner.
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/u;
const JARGON_PATTERNS: readonly RegExp[] = [
  /\bmissing[ _]source\b/iu,
  /\bKPI-Prompts?\b/u,
  /\b(?:Task-|Katalog-|KPI-)?Rezept(?:e|en)?\b/u,
  /\bNative-Quellen?\b/iu,
  /\bSupervisor-Befehle?\b/u,
  /\bqueued\b/iu,
  /\bgebundene[nr]? (?:Werte|KPIs?|Kennzahlen|Task-Kennzahlen)\b/u,
  /\b(?:Werte?|KPIs?|Kennzahlen) (?:ist |sind )?(?:noch )?(?:nicht )?gebunden\b/u,
];

const NO_DATA_TITLE =
  /\b(?:keine|ohne) (?:Daten|Werte|Belege|Messpunkte|Angaben|Einträge)\b|\bno (?:data|values|evidence)\b/iu;
const PLACEHOLDER_CELL = /^(?:|[-–—]|n\/?a|k\. ?A\.|keine Daten|keine Werte|no data)$/iu;

/**
 * Repairable content errors (and duplicate-text warnings) for a Jour fixe meeting deck. Run it
 * for decks an agent writes; the Owner's own canvas edits are not linted.
 */
export function lintMeetingDeck(document: SlideDocument): SlideDocumentValidationIssue[] {
  const issues: SlideDocumentValidationIssue[] = [];
  document.slides.forEach((slide, slideIndex) => {
    const base: Array<string | number> = ["slides", slideIndex];
    lintTitleRepeats(slide, base, issues);
    if (slideIndex > 0 && NO_DATA_TITLE.test(slide.title)) {
      issues.push(
        issue("content.empty_slide", [...base, "title"], slide.id, {
          message: `Slide "${slide.title}" only states that evidence is missing.`,
          repairHint:
            "Leave this slide out and name the missing evidence once, on the goal and status slide.",
        }),
      );
    }
    slide.blocks.forEach((block, blockIndex) => {
      if (block.type === "table" && isPlaceholderTable(block)) {
        issues.push(
          issue("content.placeholder_table", [...base, "blocks", blockIndex], slide.id, {
            blockId: block.id,
            message: 'The table holds no real row, only placeholders such as "—" or "keine Daten".',
            repairHint:
              "Remove the table; name the missing evidence once on the goal and status slide.",
          }),
        );
      }
    });
    for (const segment of slideSegments(slide, base)) lintWording(segment, issues);
  });
  document.slides.forEach((slide, slideIndex) => lintNarration(slide, slideIndex, issues));
  lintDuplicates(document, issues);
  return issues;
}

function lintTitleRepeats(
  slide: SlideNode,
  base: Array<string | number>,
  issues: SlideDocumentValidationIssue[],
) {
  const title = normalized(slide.title);
  if (!title) return;
  slide.blocks.forEach((block, blockIndex) => {
    if (block.type !== "heading") return;
    const heading = normalized(block.text);
    const repeats =
      heading === title ||
      heading.startsWith(title) ||
      (title.startsWith(heading) && heading.length >= title.length * 0.6);
    if (!repeats) return;
    issues.push(
      issue("content.title_repeated", [...base, "blocks", blockIndex, "text"], slide.id, {
        blockId: block.id,
        message: `Heading "${block.text}" repeats the slide title "${slide.title}".`,
        repairHint:
          "Remove the heading; the title is already drawn as the headline. Use headings only for different sub-headings.",
      }),
    );
  });
}

function lintWording(segment: Segment, issues: SlideDocumentValidationIssue[]) {
  for (const [pattern, topic] of META_PATTERNS) {
    const match = pattern.exec(segment.text);
    if (!match) continue;
    issues.push(
      issue("content.meta_phrase", segment.pathSegments, segment.slideId, {
        ...(segment.blockId ? { blockId: segment.blockId } : {}),
        message: `"${match[0]}" talks about ${topic}, not about the project.`,
        received: excerpt(segment.text, match.index),
        repairHint:
          "State the project fact or the decision instead; never describe the slide, its layout, the display, the data plumbing or your own choices.",
      }),
    );
    break;
  }
  const jargon = SNAKE_CASE.exec(segment.text) ?? firstMatch(JARGON_PATTERNS, segment.text);
  if (jargon) {
    issues.push(
      issue("content.system_jargon", segment.pathSegments, segment.slideId, {
        ...(segment.blockId ? { blockId: segment.blockId } : {}),
        message: `"${jargon[0]}" is an internal term the Owner does not use.`,
        received: excerpt(segment.text, jargon.index),
        repairHint:
          'Say it in the Owner\'s words (e.g. "Gemergte PRs: Quelle noch nicht angebunden"); no internal ids, field names or system states.',
      }),
    );
  }
}

/**
 * The spoken text of a slide (its talking points) fits that slide: it exists, stays within the
 * time budget, cites only numbers the slide or its sources show, and does not read bullets aloud.
 */
function lintNarration(
  slide: SlideNode,
  slideIndex: number,
  issues: SlideDocumentValidationIssue[],
) {
  const base: Array<string | number> = ["slides", slideIndex];
  const notes = (slide.speakerNotes ?? [])
    .map((note, index) => ({ note, index }))
    .filter(({ note }) => note.kind === undefined || note.kind === "talkingPoint")
    .filter(({ note }) => note.text.trim());
  if (notes.length === 0) {
    issues.push(
      issue("narration.missing", [...base, "speakerNotes"], slide.id, {
        message: `Slide "${slide.title}" has no talking point, so its text would be read aloud.`,
        repairHint:
          "Add one talkingPoint note: what this slide means for the project, in spoken German.",
      }),
    );
    return;
  }
  const spoken = notes.map(({ note }) => note.text.trim()).join("\n\n");
  const budget = slideIndex === 0 ? TITLE_NARRATION_MAX_CHARS : NARRATION_MAX_CHARS;
  const length = [...spoken].length;
  if (length > budget) {
    issues.push(
      issue("narration.too_long", [...base, "speakerNotes"], slide.id, {
        message: `The narration has ${length} characters; this slide allows ${budget} (about ${Math.round(budget / 15.6)} seconds).`,
        repairHint:
          "Shorten the talking point: say what changed and what the Owner decides, nothing else.",
      }),
    );
  }
  const shown = slideNumberRuns(slide);
  const shownSegments = slideSegments(slide, base, false).flatMap((segment) =>
    sentences(segment.text).map((text) => tokens(text)),
  );
  for (const { note, index } of notes) {
    const path = [...base, "speakerNotes", index, "text"];
    const unsupported = numberRuns(note.text).filter(
      (run) => run.length >= 2 && !shown.has(canonicalRun(run)),
    );
    if (unsupported.length) {
      issues.push(
        issue("narration.unsupported_number", path, slide.id, {
          message: `The narration says ${[...new Set(unsupported)].join(", ")}, which neither the slide nor its sources show.`,
          received: excerpt(note.text, note.text.indexOf(unsupported[0]!)),
          repairHint:
            "Speak only numbers the slide shows or its sources state; put a missing number on the slide with its source, or leave it out.",
        }),
      );
    }
    for (const sentence of sentences(note.text)) {
      const spokenTokens = tokens(sentence);
      if (spokenTokens.size < 5) continue;
      const copied = shownSegments.find((shownTokens) => {
        if (shownTokens.size < 5) return false;
        let common = 0;
        for (const token of shownTokens) if (spokenTokens.has(token)) common += 1;
        const union = shownTokens.size + spokenTokens.size - common;
        return (
          common / union >= 0.75 || (shownTokens.size >= 6 && common / shownTokens.size >= 0.9)
        );
      });
      if (!copied) continue;
      issues.push(
        issue("narration.reads_slide", path, slide.id, {
          message: `"${sentence.trim()}" reads the slide text aloud.`,
          repairHint:
            "Say what the slide means instead of reading it: the change, its cause or the decision it asks for.",
        }),
      );
      break;
    }
  }
}

/** Digit runs a slide shows: its text, scene data (raw and as the scene displays it) and sources. */
function slideNumberRuns(slide: SlideNode): Set<string> {
  const texts: string[] = [slide.title];
  for (const segment of slideSegments(slide, [], false)) texts.push(segment.text);
  const scenes: Array<{ sceneId: string; data: unknown }> = [];
  for (const block of slide.blocks) {
    if (block.type === "scene3d") scenes.push({ sceneId: block.sceneId, data: block.data });
    if (block.type === "chart") texts.push(JSON.stringify(block.data ?? {}));
    if (block.type === "table") texts.push(block.columns.join(" "));
  }
  for (const element of slide.canvas?.elements ?? []) {
    const embed = element.customData?.learnordie;
    if (embed?.type === "scene3d") scenes.push({ sceneId: embed.sceneId, data: embed.data });
  }
  for (const { sceneId, data } of scenes) {
    const summary = businessSceneSummary(sceneId, data);
    if (summary) texts.push(summary);
    for (const value of jsonNumbers(data)) texts.push(String(value), formatNumber(value));
    texts.push(JSON.stringify(data ?? {}));
  }
  for (const source of slide.sourceRefs ?? []) {
    texts.push(source.label, source.locator ?? "", source.url ?? "");
  }
  for (const note of slide.speakerNotes ?? []) {
    if (note.kind === "source") texts.push(note.text);
  }
  return new Set(texts.flatMap(numberRuns).map(canonicalRun));
}

function jsonNumbers(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(jsonNumbers);
  if (value && typeof value === "object") return Object.values(value).flatMap(jsonNumbers);
  return [];
}

const numberRuns = (text: string) => text.match(/\d+/gu) ?? [];
const canonicalRun = (run: string) => run.replace(/^0+(?=\d)/u, "");
const tokens = (text: string) =>
  new Set(
    normalized(text)
      .split(" ")
      .filter((token) => token.length > 1),
  );

function lintDuplicates(document: SlideDocument, issues: SlideDocumentValidationIssue[]) {
  const seen = new Map<string, Segment>();
  document.slides.forEach((slide, slideIndex) => {
    const local = new Set<string>();
    for (const segment of slideSegments(slide, ["slides", slideIndex], false)) {
      for (const sentence of sentences(segment.text)) {
        const key = normalized(sentence);
        if (key.split(" ").length < 5 || local.has(key)) continue;
        local.add(key);
        const first = seen.get(key);
        if (!first) {
          seen.set(key, segment);
          continue;
        }
        issues.push(
          issue("content.duplicate_text", segment.pathSegments, segment.slideId, {
            severity: "warning",
            ...(segment.blockId ? { blockId: segment.blockId } : {}),
            message: `"${sentence.trim()}" already stands on slide "${first.slideId}".`,
            repairHint: "Say each fact once in the deck; keep it where the Owner has to act on it.",
          }),
        );
      }
    }
  });
}

/** Visible text of a slide plus its speaker notes (notes are spoken, so they are linted too). */
function slideSegments(
  slide: SlideNode,
  base: Array<string | number>,
  withNotes = true,
): Segment[] {
  const segments: Segment[] = [];
  const push = (text: string | undefined, path: Array<string | number>, blockId?: string) => {
    if (text?.trim())
      segments.push({
        slideId: slide.id,
        pathSegments: [...base, ...path],
        text,
        ...(blockId ? { blockId } : {}),
      });
  };
  if (slide.canvas) {
    slide.canvas.elements.forEach((element, index) => {
      if (element.isDeleted || element.id === `${slide.id}:title`) return;
      if (element.type === "text")
        push(element.originalText ?? element.text, ["canvas", "elements", index, "text"]);
      const embed = element.customData?.learnordie;
      if (embed?.type === "scene3d")
        push(embed.caption, ["canvas", "elements", index, "customData"]);
    });
  } else {
    slide.blocks.forEach((block, index) => {
      for (const [text, path] of blockTexts(block))
        push(text, ["blocks", index, ...path], block.id);
    });
  }
  if (withNotes) {
    // Only spoken notes; source, timing and warning notes are not read aloud.
    (slide.speakerNotes ?? []).forEach((note, index) => {
      if (note.kind === undefined || note.kind === "talkingPoint")
        push(note.text, ["speakerNotes", index, "text"]);
    });
  }

  return segments;
}

function blockTexts(block: SlideBlock): Array<[string | undefined, Array<string | number>]> {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return [[block.text, ["text"]]];
    case "bulletList":
    case "numberedList":
      return block.items.map((item, index) => [item, ["items", index]]);
    case "definition":
      return [
        [block.term, ["term"]],
        [block.definition, ["definition"]],
        [block.example, ["example"]],
      ];
    case "callout":
      return [
        [block.title, ["title"]],
        [block.text, ["text"]],
      ];
    case "figure":
      return [[block.caption, ["caption"]]];
    case "formula":
      return [[block.caption, ["caption"]]];
    case "table":
      return [
        [block.caption, ["caption"]],
        ...block.rows.flatMap((row, rowIndex) =>
          row.map((cell, cellIndex): [string, Array<string | number>] => [
            cell,
            ["rows", rowIndex, cellIndex],
          ]),
        ),
      ];
    case "chart":
      return [
        [block.title, ["title"]],
        [block.caption, ["caption"]],
      ];
    case "process":
      return block.steps.flatMap(
        (step, index): Array<[string | undefined, Array<string | number>]> => [
          [step.title, ["steps", index, "title"]],
          [step.text, ["steps", index, "text"]],
        ],
      );
    case "comparison":
      return (["left", "right"] as const).flatMap(
        (side): Array<[string | undefined, Array<string | number>]> => [
          [block[side].title, [side, "title"]],
          [block[side].body, [side, "body"]],
          ...(block[side].items ?? []).map((item, index): [string, Array<string | number>] => [
            item,
            [side, "items", index],
          ]),
        ],
      );
    case "quote":
      return [[block.text, ["text"]]];
    case "quizAnchor":
      return [[block.prompt, ["prompt"]]];
    case "scene3d":
      return [[block.caption, ["caption"]]];
    case "code":
    case "spacer":
      return [];
  }
}

function isPlaceholderTable(block: Extract<SlideBlock, { type: "table" }>): boolean {
  return (
    block.rows.length > 0 &&
    block.rows.every((row) =>
      row.every(
        (cell) => PLACEHOLDER_CELL.test((cell ?? "").trim()) || /keine Daten/iu.test(cell ?? ""),
      ),
    )
  );
}

function issue(
  code: MeetingLintCode,
  pathSegments: Array<string | number>,
  slideId: string,
  detail: {
    message: string;
    repairHint: string;
    severity?: SlideDocumentValidationIssue["severity"];
    blockId?: string;
    received?: string;
  },
): SlideDocumentValidationIssue {
  return {
    severity: detail.severity ?? "error",
    code,
    message: detail.message,
    path: pathSegments.reduce<string>(
      (path, segment) =>
        typeof segment === "number" ? `${path}[${segment}]` : `${path}.${segment}`,
      "$",
    ),
    pathSegments,
    repairHint: detail.repairHint,
    slideId,
    ...(detail.blockId ? { blockId: detail.blockId } : {}),
    ...(detail.received ? { received: detail.received } : {}),
  };
}

const normalized = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/u).filter((part) => part.trim());

function firstMatch(patterns: readonly RegExp[], text: string): RegExpExecArray | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

function excerpt(text: string, index: number): string {
  const start = Math.max(0, index - 30);
  return `${start > 0 ? "…" : ""}${text.slice(start, index + 60).trim()}${index + 60 < text.length ? "…" : ""}`;
}
