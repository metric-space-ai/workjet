import {
  SLIDE_DOCUMENT_SCHEMA_VERSION,
  createSlideDocumentRepairReport,
  validateSlideDocument,
  type QuestionLevel,
  type SlideAssetRef,
  type SlideDocument,
  type SlideDocumentValidationIssue,
  type SlideLayoutId,
  type SlideThemeId,
  type SourceReference,
  type SourceReferenceType
} from "./schema";

export const SLIDE_AGENT_PROMPT_CONTRACT_VERSION = "learnordie.slide-agent.v1" as const;

export type SlideAgentSource = {
  id: string;
  title: string;
  sourceType?: SourceReferenceType;
  materialId?: string;
  assetIds?: string[];
  locator?: string;
  page?: number;
  slide?: number;
  text?: string;
};

export type SlideAgentGenerationInput = {
  id: string;
  title: string;
  language?: string;
  aspect?: SlideDocument["aspect"];
  theme?: SlideThemeId;
  sources: SlideAgentSource[];
  assets?: SlideAssetRef[];
  maxContentSlides?: number;
  model?: string;
  promptVersion?: string;
};

export type SlideAgentBriefing = {
  contractVersion: typeof SLIDE_AGENT_PROMPT_CONTRACT_VERSION;
  topics: Array<{
    id: string;
    title: string;
    sourceIds: string[];
    keywords: string[];
  }>;
  learningGoals: string[];
  expectedMisconceptions: string[];
};

export type SlideAgentOutline = {
  contractVersion: typeof SLIDE_AGENT_PROMPT_CONTRACT_VERSION;
  sections: Array<{
    id: string;
    title: string;
    learningGoal: string;
    slides: Array<{
      id: string;
      intent: SlideDocument["slides"][number]["intent"];
      workingTitle: string;
      layout: SlideLayoutId;
      sourceIds: string[];
      requiredAssets: string[];
    }>;
  }>;
};

export type SlideAgentGenerationResult =
  | {
      ok: true;
      document: SlideDocument;
      briefing: SlideAgentBriefing;
      outline: SlideAgentOutline;
      issues: SlideDocumentValidationIssue[];
    }
  | {
      ok: false;
      document?: SlideDocument;
      briefing: SlideAgentBriefing;
      outline: SlideAgentOutline;
      issues: SlideDocumentValidationIssue[];
    };

const figureAssetKinds = new Set<SlideAssetRef["kind"]>(["figure", "photo", "diagram", "chart"]);

export function createSlideAgentBriefing(input: SlideAgentGenerationInput): SlideAgentBriefing {
  const normalizedSources = normalizeSources(input.sources);
  const topics = normalizedSources.slice(0, contentSlideLimit(input)).map((source, index) => ({
    id: stableId("topic", source.id, index),
    title: source.title.trim(),
    sourceIds: [source.id],
    keywords: extractKeywords(`${source.title} ${source.text ?? ""}`).slice(0, 6)
  }));

  return {
    contractVersion: SLIDE_AGENT_PROMPT_CONTRACT_VERSION,
    topics,
    learningGoals: topics.map((topic) => `Studierende erklären ${topic.title} anhand der bereitgestellten Quelle.`),
    expectedMisconceptions: [
      "Einzelne Begriffe werden auswendig gelernt, ohne Ursache und Wirkung zu verbinden.",
      "Grafiken, Formeln oder Tabellen werden ohne Quellenbezug übernommen.",
      "Mobile Lesbarkeit wird mit verkleinerter Desktop-Folie verwechselt."
    ]
  };
}

export function createSlideAgentOutline(
  input: SlideAgentGenerationInput,
  briefing = createSlideAgentBriefing(input)
): SlideAgentOutline {
  const sourcesById = new Map(normalizeSources(input.sources).map((source) => [source.id, source]));
  const assets = input.assets ?? [];
  const slides = briefing.topics.map((topic, index) => {
    const source = sourcesById.get(topic.sourceIds[0]);
    const requiredAssets = source ? sourceAssets(source, assets).map((asset) => asset.id).slice(0, 2) : [];
    return {
      id: stableId("slide", topic.id, index + 1),
      intent: (requiredAssets.length > 0 ? "explanation" : "concept") as SlideDocument["slides"][number]["intent"],
      workingTitle: topic.title,
      layout: chooseLayoutForSource(source, requiredAssets),
      sourceIds: topic.sourceIds,
      requiredAssets
    };
  });

  return {
    contractVersion: SLIDE_AGENT_PROMPT_CONTRACT_VERSION,
    sections: [
      {
        id: stableId("section", input.id, 0),
        title: input.title.trim(),
        learningGoal: briefing.learningGoals[0] ?? `Studierende ordnen ${input.title.trim()} fachlich ein.`,
        slides
      }
    ]
  };
}

export function generateSlideDocumentDraft(input: SlideAgentGenerationInput): SlideAgentGenerationResult {
  const briefing = createSlideAgentBriefing(input);
  const outline = createSlideAgentOutline(input, briefing);
  const sources = normalizeSources(input.sources);
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const assets = input.assets ?? [];
  const title = input.title.trim();
  const deckId = stableId("deck", input.id, 0);
  const slides: SlideDocument["slides"] = [
    {
      id: stableId("slide", `${deckId}-title`, 0),
      title,
      layout: "title_statement",
      intent: "title",
      blocks: [
        { id: stableId("block", `${deckId}-title-heading`, 0), type: "heading", text: title, level: 1 },
        {
          id: stableId("block", `${deckId}-title-context`, 1),
          type: "paragraph",
          text: sources.length > 0
            ? `Agentischer Entwurf aus ${sources.length} geprüften Quelle${sources.length === 1 ? "" : "n"}.`
            : "Agentischer Entwurf ohne externe Quelle."
        }
      ],
      sourceRefs: [manualSourceRef("agent-title-source", "Agentischer Deck-Start")]
    },
    ...outline.sections.flatMap((section) => section.slides.map((outlineSlide, index) => {
      const source = sourceMap.get(outlineSlide.sourceIds[0]);
      return sourceSlide({
        assets,
        deckId,
        index,
        outlineSlide,
        source
      });
    })),
    summarySlide(deckId, title, briefing)
  ];

  const document: SlideDocument = {
    schemaVersion: SLIDE_DOCUMENT_SCHEMA_VERSION,
    id: deckId,
    title,
    language: input.language ?? "de",
    aspect: input.aspect ?? "16:9",
    theme: input.theme ?? "learnordie-technical",
    deckSettings: {
      defaultTransition: "slide",
      showSlideNumbers: true,
      allowFragments: false,
      mobileMode: "hybrid"
    },
    slides,
    assets,
    createdBy: {
      mode: "agent",
      model: input.model,
      promptVersion: input.promptVersion ?? SLIDE_AGENT_PROMPT_CONTRACT_VERSION
    }
  };

  const validation = validateSlideDocument(document);
  if (validation.ok) {
    return {
      ok: true,
      document: validation.document,
      briefing,
      outline,
      issues: validation.issues
    };
  }

  return {
    ok: false,
    document: validation.document,
    briefing,
    outline,
    issues: validation.issues
  };
}

export function createSlideAgentRepairFeedback(document: unknown) {
  return createSlideDocumentRepairReport(document);
}

function sourceSlide({
  assets,
  deckId,
  index,
  outlineSlide,
  source
}: {
  assets: SlideAssetRef[];
  deckId: string;
  index: number;
  outlineSlide: SlideAgentOutline["sections"][number]["slides"][number];
  source?: SlideAgentSource;
}): SlideDocument["slides"][number] {
  const slideId = stableId("slide", `${deckId}-${outlineSlide.workingTitle}`, index + 1);
  const relatedAssets = source ? sourceAssets(source, assets) : [];
  const visualAsset = relatedAssets.find((asset) => figureAssetKinds.has(asset.kind));
  const sourceText = readableSourceText(source);
  const blocks: SlideDocument["slides"][number]["blocks"] = [
    { id: `${slideId}-heading`, type: "heading", text: outlineSlide.workingTitle.slice(0, 140), level: 1 },
    {
      id: `${slideId}-summary`,
      type: "paragraph",
      text: sourceText
    }
  ];

  if (sourceText.length > 180) {
    blocks.push({
      id: `${slideId}-keywords`,
      type: "bulletList",
      items: extractKeywords(sourceText).slice(0, 4).map((keyword) => `${keyword} einordnen`)
    });
  }

  if (visualAsset) {
    blocks.push({
      id: `${slideId}-visual`,
      type: "figure",
      assetId: visualAsset.id,
      altText: visualAsset.altText ?? visualAsset.description ?? visualAsset.title,
      caption: visualAsset.title,
      fit: "contain"
    });
  }

  const anchorBlockId = visualAsset ? `${slideId}-visual` : `${slideId}-summary`;
  return {
    id: slideId,
    title: outlineSlide.workingTitle.slice(0, 140),
    layout: outlineSlide.layout,
    intent: outlineSlide.intent,
    blocks,
    quizAnchors: [
      {
        id: `${slideId}-quiz-transfer`,
        level: quizLevelForIndex(index),
        blockId: anchorBlockId,
        label: "Transferfrage aus Material"
      }
    ],
    speakerNotes: source ? [
      {
        id: `${slideId}-source-note`,
        kind: "source",
        text: `Quelle: ${source.title}${source.locator ? ` (${source.locator})` : ""}.`,
        blockId: `${slideId}-summary`
      }
    ] : undefined,
    sourceRefs: [sourceReference(source, index)]
  };
}

function summarySlide(deckId: string, title: string, briefing: SlideAgentBriefing): SlideDocument["slides"][number] {
  const slideId = stableId("slide", `${deckId}-summary`, 99);
  return {
    id: slideId,
    title: "Prüfungsrelevante Verbindung",
    layout: "process_steps",
    intent: "summary",
    blocks: [
      { id: `${slideId}-heading`, type: "heading", text: "Prüfungsrelevante Verbindung", level: 1 },
      {
        id: `${slideId}-process`,
        type: "process",
        steps: briefing.learningGoals.slice(0, 4).map((goal, index) => ({
          id: `${slideId}-step-${index + 1}`,
          title: `Schritt ${index + 1}`,
          text: goal
        }))
      },
      {
        id: `${slideId}-callout`,
        type: "callout",
        tone: "key",
        title,
        text: "Der Agentenentwurf ist validiert, bleibt aber als fachlicher Vorschlag reviewpflichtig."
      }
    ],
    sourceRefs: [manualSourceRef(`${slideId}-manual-source`, "Agentische Zusammenfassung")]
  };
}

function normalizeSources(sources: SlideAgentSource[]) {
  return sources
    .filter((source) => source.title.trim().length > 0 || source.text?.trim())
    .map((source, index) => ({
      ...source,
      id: stableId("source", source.id || source.title || "material", index),
      title: source.title.trim() || `Quelle ${index + 1}`,
      text: source.text?.trim()
    }));
}

function sourceAssets(source: SlideAgentSource, assets: SlideAssetRef[]) {
  const explicit = new Set(source.assetIds ?? []);
  return assets.filter((asset) => (
    explicit.has(asset.id) ||
    asset.source?.materialId === source.materialId ||
    asset.source?.id === source.id ||
    asset.source?.assetId === source.id
  ));
}

function chooseLayoutForSource(source: SlideAgentSource | undefined, assetIds: string[]): SlideLayoutId {
  if (!source) return "technical_one_column";
  if (assetIds.length > 0) return "technical_figure_right";
  if ((source.text?.length ?? 0) > 620) return "technical_two_column";
  return "technical_one_column";
}

function readableSourceText(source: SlideAgentSource | undefined) {
  if (!source) return "Diese Folie wurde aus dem agentischen Outline erzeugt und benötigt Quellenreview.";
  const text = source.text?.replace(/\s+/g, " ").trim();
  if (text) return truncateSentence(text, 420);
  return `Diese Folie verdichtet die Quelle "${source.title}".`;
}

function sourceReference(source: SlideAgentSource | undefined, index: number): SourceReference {
  if (!source) return manualSourceRef(`agent-source-${index + 1}`, `Agentische Quelle ${index + 1}`);
  return {
    id: stableId("source-ref", source.id, index),
    sourceType: source.sourceType ?? "material",
    label: source.title,
    materialId: source.materialId,
    locator: source.locator,
    page: source.page,
    slide: source.slide
  };
}

function manualSourceRef(id: string, label: string): SourceReference {
  return {
    id: stableId("source-ref", id, 0),
    sourceType: "manual",
    label
  };
}

function contentSlideLimit(input: SlideAgentGenerationInput) {
  return Math.max(1, Math.min(input.maxContentSlides ?? 5, 12));
}

function quizLevelForIndex(index: number): QuestionLevel {
  const levels: QuestionLevel[] = ["4.0", "3.0", "2.0", "1.0"];
  return levels[index % levels.length];
}

function extractKeywords(text: string) {
  const stopWords = new Set(["und", "oder", "mit", "der", "die", "das", "eine", "einer", "einen", "aus", "für", "von", "bei", "den", "dem", "des", "ist", "sind", "werden"]);
  const words = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !stopWords.has(word.toLowerCase()));
  return Array.from(new Set(words)).slice(0, 10);
}

function stableId(prefix: string, value: string, index: number) {
  const clean = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${prefix}-${clean || index + 1}`.slice(0, 120);
}

function truncateSentence(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength - 1);
  const sentenceEnd = Math.max(truncated.lastIndexOf("."), truncated.lastIndexOf(";"), truncated.lastIndexOf(":"));
  return `${truncated.slice(0, sentenceEnd > 180 ? sentenceEnd + 1 : truncated.length).trim()}…`;
}
