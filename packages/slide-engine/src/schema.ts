import { z, type ZodIssue } from "zod";
import { canvasSceneSchema } from "./excalidraw/canvas-schema";
export { canvasSceneSchema, canvasElementSchema, canvasEmbedSchema } from "./excalidraw/canvas-schema";
export type { CanvasScene, CanvasElement, CanvasEmbed } from "./excalidraw/canvas-schema";

export const SLIDE_DOCUMENT_SCHEMA_VERSION = "learnordie.slide.v1" as const;

export const slideAspectValues = ["16:9", "16:10", "4:3"] as const;
export const slideThemeIdValues = [
  "learnordie-north",
  "learnordie-technical",
  "learnordie-dark-room"
] as const;
export const slideTransitionValues = ["none", "fade", "slide"] as const;
export const slideMobileModeValues = ["reflow", "scaled", "hybrid"] as const;
export const slideLayoutIdValues = [
  "title_statement",
  "section_divider",
  "technical_one_column",
  "technical_two_column",
  "technical_figure_right",
  "technical_figure_left",
  "definition_with_example",
  "formula_derivation",
  "table_focus",
  "chart_focus",
  "comparison_split",
  "process_steps",
  "case_study",
  "quiz_transition"
] as const;
export const slideIntentValues = [
  "title",
  "concept",
  "definition",
  "explanation",
  "derivation",
  "example",
  "comparison",
  "summary",
  "quiz",
  "transition"
] as const;
export const slideBlockTypeValues = [
  "heading",
  "paragraph",
  "bulletList",
  "numberedList",
  "definition",
  "callout",
  "figure",
  "formula",
  "table",
  "chart",
  "process",
  "comparison",
  "code",
  "quote",
  "quizAnchor",
  "spacer",
  "scene3d"
] as const;
export const scene3dSceneIdValues = [
  "modell.morph",
  "modell.miniature",
  "modell.law",
  "modell.limits",
  "modell.runtime",
  "modell.learning",
  "modell.language",
  "modell.transfer"
] as const;
export const slideAssetKindValues = [
  "text",
  "figure",
  "photo",
  "diagram",
  "chart",
  "formula",
  "table",
  "audio",
  "video",
  "sourceDocument"
] as const;
export const sourceReferenceTypeValues = ["material", "asset", "url", "legacy", "manual", "import"] as const;
export const questionLevelValues = ["4.0", "3.0", "2.0", "1.0"] as const;

const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Use a stable ASCII id without spaces.");
const shortTextSchema = z.string().trim().min(1).max(160);
const bodyTextSchema = z.string().trim().min(1).max(1200);

export const slideBBoxSchema = z
  .object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive()
  })
  .strict();

export const sourceReferenceSchema = z
  .object({
    id: stableIdSchema,
    sourceType: z.enum(sourceReferenceTypeValues),
    label: z.string().trim().min(1).max(220),
    materialId: stableIdSchema.optional(),
    assetId: stableIdSchema.optional(),
    url: z.url().optional(),
    locator: z.string().trim().min(1).max(180).optional(),
    page: z.number().int().positive().optional(),
    slide: z.number().int().positive().optional(),
    bbox: slideBBoxSchema.optional()
  })
  .strict();

export const slideAssetRefSchema = z
  .object({
    id: stableIdSchema,
    kind: z.enum(slideAssetKindValues),
    title: shortTextSchema,
    description: z.string().trim().min(1).max(500).optional(),
    storageKey: z.string().trim().min(1).max(500).optional(),
    previewKey: z.string().trim().min(1).max(500).optional(),
    url: z.url().optional(),
    altText: z.string().trim().min(1).max(320).optional(),
    extractedText: z.string().trim().min(1).max(10000).optional(),
    structuredData: z.unknown().optional(),
    source: sourceReferenceSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    quality: z
      .object({
        extractionConfidence: z.number().min(0).max(1).optional(),
        needsReview: z.boolean(),
        reason: z.string().trim().min(1).max(320).optional()
      })
      .strict()
      .optional()
  })
  .strict();

const blockBaseSchema = z
  .object({
    id: stableIdSchema
  })
  .strict();

const headingBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("heading"),
    text: z.string().trim().min(1).max(140),
    level: z.number().int().min(1).max(3).optional()
  })
  .strict();

const paragraphBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("paragraph"),
    text: bodyTextSchema
  })
  .strict();

const bulletListBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("bulletList"),
    items: z.array(z.string().trim().min(1).max(220)).min(1).max(10)
  })
  .strict();

const numberedListBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("numberedList"),
    items: z.array(z.string().trim().min(1).max(220)).min(1).max(10)
  })
  .strict();

const definitionBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("definition"),
    term: shortTextSchema,
    definition: bodyTextSchema,
    example: z.string().trim().min(1).max(500).optional()
  })
  .strict();

const calloutBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("callout"),
    tone: z.enum(["key", "info", "warning", "tip"]),
    title: shortTextSchema.optional(),
    text: bodyTextSchema
  })
  .strict();

const figureBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("figure"),
    assetId: stableIdSchema,
    altText: z.string().trim().min(1).max(320),
    caption: z.string().trim().min(1).max(240).optional(),
    fit: z.enum(["contain", "cover", "scale-down"]).optional()
  })
  .strict();

const formulaBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("formula"),
    latex: z.string().trim().min(1).max(2000).optional(),
    mathMl: z.string().trim().min(1).max(4000).optional(),
    caption: z.string().trim().min(1).max(240).optional()
  })
  .strict();

const tableBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("table"),
    caption: z.string().trim().min(1).max(240).optional(),
    columns: z.array(z.string().trim().min(1).max(120)).min(1).max(8),
    rows: z.array(z.array(z.string().trim().max(400)).min(1).max(8)).min(1).max(40),
    mobileStrategy: z.enum(["stack", "scroll", "cards"])
  })
  .strict();

const chartBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("chart"),
    chartType: z.enum(["line", "bar", "area", "scatter", "pie"]),
    title: shortTextSchema.optional(),
    assetId: stableIdSchema.optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    caption: z.string().trim().min(1).max(240).optional()
  })
  .strict();

const processBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("process"),
    steps: z
      .array(
        z
          .object({
            id: stableIdSchema.optional(),
            title: shortTextSchema,
            text: z.string().trim().min(1).max(400).optional()
          })
          .strict()
      )
      .min(2)
      .max(8)
  })
  .strict();

const comparisonSideSchema = z
  .object({
    title: shortTextSchema,
    body: z.string().trim().min(1).max(500).optional(),
    items: z.array(z.string().trim().min(1).max(180)).min(1).max(6).optional()
  })
  .strict();

const comparisonBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("comparison"),
    left: comparisonSideSchema,
    right: comparisonSideSchema
  })
  .strict();

const codeBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("code"),
    language: z.string().trim().min(1).max(40),
    code: z.string().min(1).max(6000),
    caption: z.string().trim().min(1).max(240).optional()
  })
  .strict();

const quoteBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("quote"),
    text: bodyTextSchema,
    attribution: z.string().trim().min(1).max(180).optional()
  })
  .strict();

const quizAnchorBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("quizAnchor"),
    anchorId: stableIdSchema,
    level: z.enum(questionLevelValues),
    prompt: z.string().trim().min(1).max(260).optional()
  })
  .strict();

const spacerBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("spacer"),
    size: z.enum(["small", "medium", "large"])
  })
  .strict();

// Interaktive 3D-Szene aus der engine-eigenen Szenenbibliothek. Der Block traegt
// nur eine Szenen-ID und Texte; ausfuehrbarer Code kommt nie aus dem Dokument.
const scene3dBlockSchema = blockBaseSchema
  .extend({
    type: z.literal("scene3d"),
    sceneId: z.enum(scene3dSceneIdValues),
    altText: z.string().trim().min(1).max(320),
    caption: z.string().trim().min(1).max(240).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color such as #8fcfc2.")
      .optional()
  })
  .strict();

export const slideBlockSchema = z.discriminatedUnion("type", [
  headingBlockSchema,
  paragraphBlockSchema,
  bulletListBlockSchema,
  numberedListBlockSchema,
  definitionBlockSchema,
  calloutBlockSchema,
  figureBlockSchema,
  formulaBlockSchema,
  tableBlockSchema,
  chartBlockSchema,
  processBlockSchema,
  comparisonBlockSchema,
  codeBlockSchema,
  quoteBlockSchema,
  quizAnchorBlockSchema,
  spacerBlockSchema,
  scene3dBlockSchema
]);

export const speakerNoteSchema = z
  .object({
    id: stableIdSchema,
    kind: z.enum(["talkingPoint", "source", "timing", "warning"]).optional(),
    text: z.string().trim().min(1).max(1600),
    blockId: stableIdSchema.optional()
  })
  .strict();

export const quizAnchorSchema = z
  .object({
    id: stableIdSchema,
    level: z.enum(questionLevelValues),
    blockId: stableIdSchema,
    label: z.string().trim().min(1).max(160).optional()
  })
  .strict();

export const slideNodeSchema = z
  .object({
    id: stableIdSchema,
    title: z.string().trim().min(1).max(140),
    layout: z.enum(slideLayoutIdValues),
    intent: z.enum(slideIntentValues),
    blocks: z.array(slideBlockSchema).min(1).max(24),
    canvas: canvasSceneSchema.optional(),
    speakerNotes: z.array(speakerNoteSchema).max(12).optional(),
    quizAnchors: z.array(quizAnchorSchema).max(12).optional(),
    sourceRefs: z.array(sourceReferenceSchema).min(1).max(20)
  })
  .strict();

export const slideDocumentV1Schema = z
  .object({
    schemaVersion: z.literal(SLIDE_DOCUMENT_SCHEMA_VERSION),
    id: stableIdSchema,
    title: z.string().trim().min(1).max(180),
    language: z.string().trim().min(2).max(16),
    aspect: z.enum(slideAspectValues),
    theme: z.enum(slideThemeIdValues),
    deckSettings: z
      .object({
        defaultTransition: z.enum(slideTransitionValues),
        showSlideNumbers: z.boolean(),
        allowFragments: z.boolean(),
        mobileMode: z.enum(slideMobileModeValues)
      })
      .strict(),
    slides: z.array(slideNodeSchema).min(1).max(160),
    assets: z.array(slideAssetRefSchema).max(1000),
    createdBy: z
      .object({
        mode: z.enum(["agent", "manual", "import"]),
        model: z.string().trim().min(1).max(120).optional(),
        promptVersion: z.string().trim().min(1).max(120).optional()
      })
      .strict()
  })
  .strict();

export const slideDocumentSchema = slideDocumentV1Schema;

export type SlideAspect = (typeof slideAspectValues)[number];
export type SlideThemeId = (typeof slideThemeIdValues)[number];
export type SlideLayoutId = (typeof slideLayoutIdValues)[number];
export type SlideIntent = (typeof slideIntentValues)[number];
export type SlideBlockType = (typeof slideBlockTypeValues)[number];
export type Scene3DSceneId = (typeof scene3dSceneIdValues)[number];
export type SlideAssetKind = (typeof slideAssetKindValues)[number];
export type SourceReferenceType = (typeof sourceReferenceTypeValues)[number];
export type QuestionLevel = (typeof questionLevelValues)[number];
export type SlideBBox = z.infer<typeof slideBBoxSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type SlideAssetRef = z.infer<typeof slideAssetRefSchema>;
export type SlideBlock = z.infer<typeof slideBlockSchema>;
export type SpeakerNote = z.infer<typeof speakerNoteSchema>;
export type QuizAnchor = z.infer<typeof quizAnchorSchema>;
export type SlideNode = z.infer<typeof slideNodeSchema>;
export type SlideDocument = z.infer<typeof slideDocumentV1Schema>;

export type SlideDocumentValidationSeverity = "error" | "warning";

export type SlideDocumentValidationIssue = {
  severity: SlideDocumentValidationSeverity;
  code: string;
  message: string;
  path: string;
  pathSegments: Array<string | number>;
  repairHint: string;
  slideId?: string;
  blockId?: string;
  assetId?: string;
  expected?: string;
  received?: string;
};

export type SlideDocumentValidationResult =
  | {
      ok: true;
      document: SlideDocument;
      issues: SlideDocumentValidationIssue[];
    }
  | {
      ok: false;
      document?: SlideDocument;
      issues: SlideDocumentValidationIssue[];
    };

export type SlideDocumentRepairReport = {
  schemaVersion: typeof SLIDE_DOCUMENT_SCHEMA_VERSION;
  ok: false;
  issues: SlideDocumentValidationIssue[];
};

type LayoutBudget = {
  maxBlocks: number;
  maxTextChars: number;
  allowedBlockTypes?: readonly SlideBlockType[];
};

export const slideLayoutBudgets: Record<SlideLayoutId, LayoutBudget> = {
  title_statement: {
    maxBlocks: 4,
    maxTextChars: 320,
    allowedBlockTypes: ["heading", "paragraph", "quote", "spacer"]
  },
  section_divider: {
    maxBlocks: 4,
    maxTextChars: 260,
    allowedBlockTypes: ["heading", "paragraph", "quote", "spacer"]
  },
  technical_one_column: {
    maxBlocks: 8,
    maxTextChars: 1200
  },
  technical_two_column: {
    maxBlocks: 10,
    maxTextChars: 1400
  },
  technical_figure_right: {
    maxBlocks: 8,
    maxTextChars: 900,
    allowedBlockTypes: ["heading", "paragraph", "bulletList", "numberedList", "definition", "callout", "figure", "formula", "scene3d", "quizAnchor", "spacer"]
  },
  technical_figure_left: {
    maxBlocks: 8,
    maxTextChars: 900,
    allowedBlockTypes: ["heading", "paragraph", "bulletList", "numberedList", "definition", "callout", "figure", "formula", "scene3d", "quizAnchor", "spacer"]
  },
  definition_with_example: {
    maxBlocks: 8,
    maxTextChars: 1000,
    allowedBlockTypes: ["heading", "paragraph", "definition", "callout", "figure", "formula", "quizAnchor", "spacer"]
  },
  formula_derivation: {
    maxBlocks: 10,
    maxTextChars: 900,
    allowedBlockTypes: ["heading", "paragraph", "bulletList", "numberedList", "formula", "callout", "quizAnchor", "spacer"]
  },
  table_focus: {
    maxBlocks: 6,
    maxTextChars: 700,
    allowedBlockTypes: ["heading", "paragraph", "table", "callout", "quizAnchor", "spacer"]
  },
  chart_focus: {
    maxBlocks: 6,
    maxTextChars: 700,
    allowedBlockTypes: ["heading", "paragraph", "chart", "callout", "quizAnchor", "spacer"]
  },
  comparison_split: {
    maxBlocks: 7,
    maxTextChars: 1000,
    allowedBlockTypes: ["heading", "paragraph", "comparison", "callout", "quizAnchor", "spacer"]
  },
  process_steps: {
    maxBlocks: 7,
    maxTextChars: 900,
    allowedBlockTypes: ["heading", "paragraph", "process", "callout", "quizAnchor", "spacer"]
  },
  case_study: {
    maxBlocks: 10,
    maxTextChars: 1400
  },
  quiz_transition: {
    maxBlocks: 5,
    maxTextChars: 520,
    allowedBlockTypes: ["heading", "paragraph", "callout", "quizAnchor", "spacer"]
  }
};

const figureCompatibleAssetKinds = new Set<SlideAssetKind>(["figure", "photo", "diagram", "chart"]);

export function validateSlideDocument(input: unknown): SlideDocumentValidationResult {
  const parsed = slideDocumentV1Schema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(zodIssueToRepairIssue)
    };
  }

  const semanticIssues = validateSlideDocumentSemantics(parsed.data);
  const hasErrors = semanticIssues.some((issue) => issue.severity === "error");

  if (hasErrors) {
    return {
      ok: false,
      document: parsed.data,
      issues: semanticIssues
    };
  }

  return {
    ok: true,
    document: parsed.data,
    issues: semanticIssues
  };
}

export function parseSlideDocument(input: unknown): SlideDocument {
  const result = validateSlideDocument(input);
  if (!result.ok) {
    throw new SlideDocumentValidationError(result.issues);
  }
  return result.document;
}

export function createSlideDocumentRepairReport(input: unknown): SlideDocumentRepairReport | null {
  const result = validateSlideDocument(input);
  if (result.ok) return null;

  return {
    schemaVersion: SLIDE_DOCUMENT_SCHEMA_VERSION,
    ok: false,
    issues: result.issues
  };
}

export class SlideDocumentValidationError extends Error {
  readonly issues: SlideDocumentValidationIssue[];

  constructor(issues: SlideDocumentValidationIssue[]) {
    super(`SlideDocument validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}.`);
    this.name = "SlideDocumentValidationError";
    this.issues = issues;
  }
}

function validateSlideDocumentSemantics(document: SlideDocument): SlideDocumentValidationIssue[] {
  const issues: SlideDocumentValidationIssue[] = [];
  const assetIds = new Map<string, SlideAssetRef>();
  const slideIds = new Set<string>();

  document.assets.forEach((asset, assetIndex) => {
    if (assetIds.has(asset.id)) {
      issues.push(makeIssue({
        code: "asset.duplicate_id",
        message: `Asset id "${asset.id}" is used more than once.`,
        pathSegments: ["assets", assetIndex, "id"],
        assetId: asset.id,
        repairHint: "Keep asset ids unique and update every block reference to the surviving id."
      }));
    }
    assetIds.set(asset.id, asset);
  });

  document.slides.forEach((slide, slideIndex) => {
    if (slideIds.has(slide.id)) {
      issues.push(makeIssue({
        code: "slide.duplicate_id",
        message: `Slide id "${slide.id}" is used more than once.`,
        pathSegments: ["slides", slideIndex, "id"],
        slideId: slide.id,
        repairHint: "Assign a stable unique id to this slide and update external references."
      }));
    }
    slideIds.add(slide.id);

    validateSlideNodeSemantics(slide, slideIndex, assetIds, issues);
  });

  return issues;
}

function validateSlideNodeSemantics(
  slide: SlideNode,
  slideIndex: number,
  assetIds: Map<string, SlideAssetRef>,
  issues: SlideDocumentValidationIssue[]
) {
  const blockIds = new Set<string>();
  const quizAnchorIds = new Set<string>();
  const budget = slideLayoutBudgets[slide.layout];

  slide.blocks.forEach((block, blockIndex) => {
    if (blockIds.has(block.id)) {
      issues.push(makeIssue({
        code: "block.duplicate_id",
        message: `Block id "${block.id}" is used more than once on slide "${slide.id}".`,
        pathSegments: ["slides", slideIndex, "blocks", blockIndex, "id"],
        slideId: slide.id,
        blockId: block.id,
        repairHint: "Give each block on the slide a unique id so notes, quiz anchors, and repair patches can target it."
      }));
    }
    blockIds.add(block.id);

    validateBlockSemantics(block, slide, slideIndex, blockIndex, assetIds, issues);
  });

  slide.quizAnchors?.forEach((anchor, anchorIndex) => {
    if (quizAnchorIds.has(anchor.id)) {
      issues.push(makeIssue({
        code: "quiz_anchor.duplicate_id",
        message: `Quiz anchor id "${anchor.id}" is used more than once on slide "${slide.id}".`,
        pathSegments: ["slides", slideIndex, "quizAnchors", anchorIndex, "id"],
        slideId: slide.id,
        repairHint: "Keep quiz anchor ids unique on the slide."
      }));
    }
    quizAnchorIds.add(anchor.id);

    if (!blockIds.has(anchor.blockId)) {
      issues.push(makeIssue({
        code: "quiz_anchor.missing_block",
        message: `Quiz anchor "${anchor.id}" points to missing block "${anchor.blockId}".`,
        pathSegments: ["slides", slideIndex, "quizAnchors", anchorIndex, "blockId"],
        slideId: slide.id,
        blockId: anchor.blockId,
        repairHint: "Point the quiz anchor to an existing block id on the same slide."
      }));
    }
  });

  slide.speakerNotes?.forEach((note, noteIndex) => {
    if (note.blockId && !blockIds.has(note.blockId)) {
      issues.push(makeIssue({
        code: "speaker_note.missing_block",
        message: `Speaker note "${note.id}" points to missing block "${note.blockId}".`,
        pathSegments: ["slides", slideIndex, "speakerNotes", noteIndex, "blockId"],
        slideId: slide.id,
        blockId: note.blockId,
        repairHint: "Remove the blockId or point the note to an existing block on the same slide."
      }));
    }
  });

  if (budget) {
    if (slide.blocks.length > budget.maxBlocks) {
      issues.push(makeIssue({
        severity: "warning",
        code: "layout.block_budget_exceeded",
        message: `Slide "${slide.id}" uses ${slide.blocks.length} blocks; layout "${slide.layout}" is budgeted for ${budget.maxBlocks}.`,
        pathSegments: ["slides", slideIndex, "blocks"],
        slideId: slide.id,
        expected: `<= ${budget.maxBlocks} blocks`,
        received: `${slide.blocks.length} blocks`,
        repairHint: "Split the slide, shorten the content, or choose a layout with a larger block budget."
      }));
    }

    const textLength = slideTextLength(slide);
    if (textLength > budget.maxTextChars) {
      issues.push(makeIssue({
        severity: "warning",
        code: "layout.text_budget_exceeded",
        message: `Slide "${slide.id}" has ${textLength} text characters; layout "${slide.layout}" is budgeted for ${budget.maxTextChars}.`,
        pathSegments: ["slides", slideIndex, "blocks"],
        slideId: slide.id,
        expected: `<= ${budget.maxTextChars} chars`,
        received: `${textLength} chars`,
        repairHint: "Reduce copy, move detail to speaker notes, or split this into multiple slides."
      }));
    }

    const allowedBlockTypes = budget.allowedBlockTypes;
    if (allowedBlockTypes) {
      slide.blocks.forEach((block, blockIndex) => {
        if (!allowedBlockTypes.includes(block.type)) {
          issues.push(makeIssue({
            severity: "warning",
            code: "layout.unexpected_block_type",
            message: `Block type "${block.type}" is unusual for layout "${slide.layout}".`,
            pathSegments: ["slides", slideIndex, "blocks", blockIndex, "type"],
            slideId: slide.id,
            blockId: block.id,
            expected: allowedBlockTypes.join(", "),
            received: block.type,
            repairHint: "Choose a matching layout or replace the block with one supported by the selected layout."
          }));
        }
      });
    }
  }
}

function validateBlockSemantics(
  block: SlideBlock,
  slide: SlideNode,
  slideIndex: number,
  blockIndex: number,
  assetIds: Map<string, SlideAssetRef>,
  issues: SlideDocumentValidationIssue[]
) {
  if (block.type === "figure") {
    const asset = assetIds.get(block.assetId);
    if (!asset) {
      issues.push(makeIssue({
        code: "asset.missing_reference",
        message: `Figure block "${block.id}" references missing asset "${block.assetId}".`,
        pathSegments: ["slides", slideIndex, "blocks", blockIndex, "assetId"],
        slideId: slide.id,
        blockId: block.id,
        assetId: block.assetId,
        repairHint: "Add the asset to document.assets or update the figure block to an existing asset id."
      }));
    } else if (!figureCompatibleAssetKinds.has(asset.kind)) {
      issues.push(makeIssue({
        code: "asset.incompatible_kind",
        message: `Figure block "${block.id}" references "${asset.kind}" asset "${asset.id}".`,
        pathSegments: ["slides", slideIndex, "blocks", blockIndex, "assetId"],
        slideId: slide.id,
        blockId: block.id,
        assetId: asset.id,
        expected: "figure, photo, diagram, or chart",
        received: asset.kind,
        repairHint: "Use a visual asset for figure blocks or change the block type to match the asset."
      }));
    }
  }

  if (block.type === "formula") {
    const formulaSourceCount = [block.latex, block.mathMl].filter(Boolean).length;
    if (formulaSourceCount !== 1) {
      issues.push(makeIssue({
        code: "formula.source_ambiguity",
        message: `Formula block "${block.id}" must provide exactly one of latex or mathMl.`,
        pathSegments: ["slides", slideIndex, "blocks", blockIndex],
        slideId: slide.id,
        blockId: block.id,
        expected: "exactly one formula source",
        received: `${formulaSourceCount} formula sources`,
        repairHint: "Set either latex or mathMl, not both."
      }));
    }
  }

  if (block.type === "table") {
    block.rows.forEach((row, rowIndex) => {
      if (row.length !== block.columns.length) {
        issues.push(makeIssue({
          code: "table.row_width_mismatch",
          message: `Table row ${rowIndex + 1} has ${row.length} cells but the table has ${block.columns.length} columns.`,
          pathSegments: ["slides", slideIndex, "blocks", blockIndex, "rows", rowIndex],
          slideId: slide.id,
          blockId: block.id,
          expected: `${block.columns.length} cells`,
          received: `${row.length} cells`,
          repairHint: "Make each row match the column count, adding empty strings for intentionally blank cells."
        }));
      }
    });
  }

  if (block.type === "chart") {
    if (!block.assetId && !block.data) {
      issues.push(makeIssue({
        code: "chart.missing_data",
        message: `Chart block "${block.id}" must provide assetId or structured data.`,
        pathSegments: ["slides", slideIndex, "blocks", blockIndex],
        slideId: slide.id,
        blockId: block.id,
        repairHint: "Reference a chart asset or provide structured chart data."
      }));
    }

    if (block.assetId) {
      const asset = assetIds.get(block.assetId);
      if (!asset) {
        issues.push(makeIssue({
          code: "asset.missing_reference",
          message: `Chart block "${block.id}" references missing asset "${block.assetId}".`,
          pathSegments: ["slides", slideIndex, "blocks", blockIndex, "assetId"],
          slideId: slide.id,
          blockId: block.id,
          assetId: block.assetId,
          repairHint: "Add the chart asset to document.assets or update the chart block to an existing asset id."
        }));
      } else if (asset.kind !== "chart") {
        issues.push(makeIssue({
          severity: "warning",
          code: "asset.unexpected_chart_kind",
          message: `Chart block "${block.id}" references "${asset.kind}" asset "${asset.id}".`,
          pathSegments: ["slides", slideIndex, "blocks", blockIndex, "assetId"],
          slideId: slide.id,
          blockId: block.id,
          assetId: asset.id,
          expected: "chart",
          received: asset.kind,
          repairHint: "Prefer chart assets for chart blocks, or use a figure block for rendered visuals."
        }));
      }
    }
  }

  if (block.type === "comparison") {
    validateComparisonSide(block.left, "left", slide, slideIndex, blockIndex, block.id, issues);
    validateComparisonSide(block.right, "right", slide, slideIndex, blockIndex, block.id, issues);
  }
}

function validateComparisonSide(
  side: { body?: string; items?: string[] },
  sideName: "left" | "right",
  slide: SlideNode,
  slideIndex: number,
  blockIndex: number,
  blockId: string,
  issues: SlideDocumentValidationIssue[]
) {
  if (!side.body && !side.items?.length) {
    issues.push(makeIssue({
      code: "comparison.empty_side",
      message: `Comparison block "${blockId}" has no content on the ${sideName} side.`,
      pathSegments: ["slides", slideIndex, "blocks", blockIndex, sideName],
      slideId: slide.id,
      blockId,
      repairHint: "Add either body text or list items to both sides of the comparison."
    }));
  }
}

function zodIssueToRepairIssue(issue: ZodIssue): SlideDocumentValidationIssue {
  const pathSegments = issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment));

  return makeIssue({
    code: `schema.${issue.code}`,
    message: issue.message,
    pathSegments,
    expected: "expected" in issue ? String(issue.expected) : undefined,
    received: "received" in issue ? String(issue.received) : undefined,
    repairHint: repairHintForZodIssue(issue)
  });
}

function repairHintForZodIssue(issue: ZodIssue): string {
  if (issue.path.length === 0) {
    return "Return a single SlideDocument object that matches learnordie.slide.v1.";
  }

  const path = pathToString(issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)));
  if (issue.code === "invalid_type") {
    return `Set ${path} to the required type or remove it if the field is optional.`;
  }
  if (issue.code === "unrecognized_keys") {
    return `Remove unsupported fields from ${path}; v1 accepts only the documented SlideDocument keys.`;
  }
  if (issue.code === "invalid_value") {
    return `Use one of the allowed enum/literal values at ${path}.`;
  }
  if (issue.code === "too_small" || issue.code === "too_big") {
    return `Adjust the value at ${path} to fit the allowed size or range.`;
  }

  return `Repair the value at ${path} so it matches the SlideDocument v1 schema.`;
}

function makeIssue(issue: Omit<SlideDocumentValidationIssue, "severity" | "path"> & { severity?: SlideDocumentValidationSeverity }): SlideDocumentValidationIssue {
  const { severity, ...rest } = issue;

  return {
    ...rest,
    severity: severity ?? "error",
    path: pathToString(issue.pathSegments)
  };
}

function pathToString(pathSegments: Array<string | number>): string {
  if (pathSegments.length === 0) return "$";

  return pathSegments.reduce<string>((path, segment) => {
    if (typeof segment === "number") return `${path}[${segment}]`;
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) return `${path}.${segment}`;
    return `${path}[${JSON.stringify(segment)}]`;
  }, "$");
}

function slideTextLength(slide: SlideNode): number {
  return slide.blocks.reduce((total, block) => total + blockTextLength(block), slide.title.length);
}

function blockTextLength(block: SlideBlock): number {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote":
      return block.text.length;
    case "bulletList":
    case "numberedList":
      return block.items.join("").length;
    case "definition":
      return block.term.length + block.definition.length + (block.example?.length ?? 0);
    case "callout":
      return (block.title?.length ?? 0) + block.text.length;
    case "figure":
      return (block.caption?.length ?? 0) + block.altText.length;
    case "formula":
      return (block.caption?.length ?? 0) + (block.latex?.length ?? 0) + (block.mathMl?.length ?? 0);
    case "table":
      return (block.caption?.length ?? 0) + block.columns.join("").length + block.rows.flat().join("").length;
    case "chart":
      return (block.title?.length ?? 0) + (block.caption?.length ?? 0);
    case "process":
      return block.steps.reduce((total, step) => total + step.title.length + (step.text?.length ?? 0), 0);
    case "comparison":
      return comparisonSideTextLength(block.left) + comparisonSideTextLength(block.right);
    case "code":
      return block.language.length + block.code.length + (block.caption?.length ?? 0);
    case "quizAnchor":
      return block.anchorId.length + block.level.length + (block.prompt?.length ?? 0);
    case "spacer":
      return 0;
    case "scene3d":
      return block.altText.length + (block.caption?.length ?? 0);
  }
}

function comparisonSideTextLength(side: { title: string; body?: string; items?: string[] }): number {
  return side.title.length + (side.body?.length ?? 0) + (side.items?.join("").length ?? 0);
}
