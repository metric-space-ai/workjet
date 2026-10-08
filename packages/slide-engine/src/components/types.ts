import type { ReactNode } from "react";

import type {
  QuizAnchor,
  SlideAspect,
  SlideAssetRef,
  SlideBlock as SchemaSlideBlock,
  SlideDocument,
  SlideIntent,
  SlideLayoutId,
  SlideNode,
  SourceReference,
  SpeakerNote
} from "../schema";

export const SUPPORTED_SLIDE_BLOCK_TYPES = [
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

export type SupportedSlideBlockType = (typeof SUPPORTED_SLIDE_BLOCK_TYPES)[number];

export type SupportedSlideBlock = Extract<SchemaSlideBlock, { type: SupportedSlideBlockType }>;

export type HeadingBlock = Extract<SchemaSlideBlock, { type: "heading" }>;
export type ParagraphBlock = Extract<SchemaSlideBlock, { type: "paragraph" }>;
export type BulletListBlock = Extract<SchemaSlideBlock, { type: "bulletList" }>;
export type NumberedListBlock = Extract<SchemaSlideBlock, { type: "numberedList" }>;
export type DefinitionBlock = Extract<SchemaSlideBlock, { type: "definition" }>;
export type CalloutBlock = Extract<SchemaSlideBlock, { type: "callout" }>;
export type FigureBlock = Extract<SchemaSlideBlock, { type: "figure" }>;
export type FormulaBlock = Extract<SchemaSlideBlock, { type: "formula" }>;
export type TableBlock = Extract<SchemaSlideBlock, { type: "table" }>;
export type ChartBlock = Extract<SchemaSlideBlock, { type: "chart" }>;
export type ProcessBlock = Extract<SchemaSlideBlock, { type: "process" }>;
export type ComparisonBlock = Extract<SchemaSlideBlock, { type: "comparison" }>;
export type CodeBlock = Extract<SchemaSlideBlock, { type: "code" }>;
export type QuoteBlock = Extract<SchemaSlideBlock, { type: "quote" }>;
export type QuizAnchorBlock = Extract<SchemaSlideBlock, { type: "quizAnchor" }>;
export type SpacerBlock = Extract<SchemaSlideBlock, { type: "spacer" }>;
export type Scene3DBlock = Extract<SchemaSlideBlock, { type: "scene3d" }>;

export type SlideBlock = SchemaSlideBlock;
export type SlideAsset = SlideAssetRef;
export type SlideAssetCollection = SlideAsset[] | Record<string, SlideAsset | undefined>;
export type SlideAssetUrlResolver = (asset: SlideAsset, block: FigureBlock) => string | undefined;
export type SlideAssetRenderer = (asset: SlideAsset, block: FigureBlock) => ReactNode;
export type SlideBlockSelection = {
  slideId: string;
  blockId: string;
  blockType: SlideBlock["type"];
};
export type SlideTransition = "none" | "fade" | "slide";
export type SlideMobileMode = "reflow" | "scaled" | "hybrid";
export type TableCellValue = string;
export type TableColumn = string;
export type TableRow = string[];

export type {
  QuizAnchor,
  SlideAspect,
  SlideDocument,
  SlideIntent,
  SlideLayoutId,
  SlideNode,
  SourceReference,
  SpeakerNote
};

export function isSupportedSlideBlockType(type: string): type is SupportedSlideBlockType {
  return SUPPORTED_SLIDE_BLOCK_TYPES.includes(type as SupportedSlideBlockType);
}
