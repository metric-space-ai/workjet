import {
  SLIDE_DOCUMENT_SCHEMA_VERSION,
  type SlideAspect,
  type SlideAssetRef,
  type SlideDocument,
  type SlideNode,
  type SlideThemeId,
  validateSlideDocument
} from "./schema";
import { canvasTextForBlock } from "./excalidraw/scene";

export type LegacySlide = {
  id: string;
  eyebrow: string;
  title: string;
  topic: string;
  copy: string[];
  diagram: "bearing" | "formula" | "ramp";
};

type LegacyDiagram = LegacySlide["diagram"];
type LegacyDiagramMetadata = {
  title: string;
  description: string;
  altText: string;
};

export type LegacySlideDocumentOptions = {
  id?: string;
  title?: string;
  language?: string;
  aspect?: SlideAspect;
  theme?: SlideThemeId;
};

const legacyDiagramMetadata: Record<LegacyDiagram, LegacyDiagramMetadata> = {
  bearing: {
    title: "Legacy diagram: hydrodynamic bearing",
    description: "Schematic diagram from the original SlideCanvas bearing visual.",
    altText: "Schematic hydrodynamic bearing with shaft, bearing shell, and lubricant film."
  },
  formula: {
    title: "Legacy diagram: formula",
    description: "Formula panel from the original SlideCanvas visual.",
    altText: "Technical formula diagram for bearing operating parameters."
  },
  ramp: {
    title: "Legacy diagram: startup ramp",
    description: "Startup ramp diagram from the original SlideCanvas visual.",
    altText: "Ramp diagram showing increasing speed during startup."
  }
};

export function legacySlideToSlideNode(slide: LegacySlide, index = 0): SlideNode {
  const slideNumber = index + 1;
  const title = slide.title.trim() || `Folie ${slideNumber}`;
  // Empty draft fields are valid while editing. Omit empty optional blocks
  // rather than feeding them into the non-empty persisted document schema.
  const paragraphBlocks = slide.copy.flatMap((text, copyIndex) => text.trim() ? [{
    id: `${slide.id}-copy-${copyIndex + 1}`,
    type: "paragraph" as const,
    text
  }] : []);
  const figureBlockId = `${slide.id}-diagram`;

  return {
    id: slide.id,
    title,
    layout: "technical_figure_right",
    intent: "concept",
    blocks: [
      {
        id: `${slide.id}-heading`,
        type: "heading",
        text: title,
        level: 1
      },
      ...paragraphBlocks,
      {
        id: figureBlockId,
        type: "figure",
        assetId: legacyDiagramAssetId(slide.diagram),
        altText: legacyDiagramMetadata[slide.diagram].altText,
        caption: slide.topic.trim() || undefined,
        fit: "contain"
      }
    ],
    speakerNotes: [
      {
        id: `${slide.id}-legacy-note`,
        kind: "source",
        text: `Migrated from legacy SlideCanvas slide "${slide.eyebrow}".`,
        blockId: `${slide.id}-heading`
      }
    ],
    sourceRefs: [
      {
        id: `${slide.id}-legacy-source`,
        sourceType: "legacy",
        label: "Legacy SlideCanvas slide",
        locator: slide.eyebrow || `Slide ${slideNumber}`
      }
    ]
  };
}

export function legacySlidesToSlideDocument(
  slides: LegacySlide[],
  options: LegacySlideDocumentOptions = {}
): SlideDocument {
  const usedDiagramTypes = Array.from(new Set(slides.map((slide) => slide.diagram)));
  const document: SlideDocument = {
    schemaVersion: SLIDE_DOCUMENT_SCHEMA_VERSION,
    id: options.id ?? "legacy-slide-deck",
    title: options.title?.trim() || "Legacy Slide Deck",
    language: options.language ?? "de",
    aspect: options.aspect ?? "16:9",
    theme: options.theme ?? "learnordie-technical",
    deckSettings: {
      defaultTransition: "slide",
      showSlideNumbers: true,
      allowFragments: false,
      mobileMode: "hybrid"
    },
    slides: slides.map((slide, index) => legacySlideToSlideNode(slide, index)),
    assets: usedDiagramTypes.map(legacyDiagramToAsset),
    createdBy: {
      mode: "import",
      promptVersion: "legacy-slide-adapter-v1"
    }
  };

  const validation = validateSlideDocument(document);
  if (!validation.ok) {
    throw new Error(`Legacy slide adapter produced an invalid SlideDocument: ${validation.issues.map((issue) => issue.message).join("; ")}`);
  }

  return validation.document;
}

export function slideDocumentToLegacySlides(
  document: SlideDocument,
  fallbackSlides: LegacySlide[] = []
): LegacySlide[] {
  return document.slides.map((slide, index) => {
    const fallback = fallbackSlides.find((item) => item.id === slide.id) ?? fallbackSlides[index];
    const figureBlock = slide.blocks.find((block) => block.type === "figure");
    const copy = slide.blocks
      .filter((block) => block.type === "paragraph")
      .map((block) => (canvasTextForBlock(slide, block.id) ?? block.text).trim())
      .filter(Boolean)
      .slice(0, 4);

    return {
      id: slide.id,
      eyebrow: fallback?.eyebrow?.trim() || legacyEyebrowFromSlide(slide, index),
      title: slide.title.trim() || fallback?.title || `Folie ${index + 1}`,
      topic: figureBlock?.caption?.trim() || fallback?.topic || slide.title.trim() || `Folie ${index + 1}`,
      copy: slide.canvas ? copy : copy.length > 0 ? copy : fallback?.copy ?? [" "],
      diagram: legacyDiagramFromSlideNode(slide, fallback?.diagram ?? "bearing")
    };
  });
}

export function legacyDiagramAssetId(diagram: LegacyDiagram): string {
  return `legacy-diagram-${diagram}`;
}

function legacyEyebrowFromSlide(slide: SlideNode, index: number) {
  const legacySource = slide.sourceRefs.find((source) => source.sourceType === "legacy" && source.locator);
  return legacySource?.locator?.trim() || `Folie ${index + 1}`;
}

function legacyDiagramFromSlideNode(slide: SlideNode, fallback: LegacyDiagram): LegacyDiagram {
  const figureBlock = slide.blocks.find((block) => block.type === "figure");
  if (!figureBlock) return fallback;
  if (figureBlock.assetId === legacyDiagramAssetId("formula")) return "formula";
  if (figureBlock.assetId === legacyDiagramAssetId("ramp")) return "ramp";
  if (figureBlock.assetId === legacyDiagramAssetId("bearing")) return "bearing";
  return fallback;
}

function legacyDiagramToAsset(diagram: LegacyDiagram): SlideAssetRef {
  return {
    id: legacyDiagramAssetId(diagram),
    kind: "diagram",
    title: legacyDiagramMetadata[diagram].title,
    description: legacyDiagramMetadata[diagram].description,
    altText: legacyDiagramMetadata[diagram].altText,
    tags: ["legacy", "slide-canvas", diagram],
    quality: {
      needsReview: false
    },
    source: {
      id: `legacy-source-${diagram}`,
      sourceType: "legacy",
      label: "Legacy SlideCanvas Diagram component",
      locator: diagram
    }
  };
}
