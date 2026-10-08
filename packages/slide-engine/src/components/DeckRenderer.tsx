import type { CSSProperties } from "react";

import { SlideRenderer } from "./SlideRenderer";
import type {
  SlideAssetCollection,
  SlideAssetRenderer,
  SlideAssetUrlResolver,
  SlideBlockSelection,
  SlideDocument
} from "./types";

export type DeckRendererProps = {
  document: SlideDocument;
  assets?: SlideAssetCollection;
  renderAsset?: SlideAssetRenderer;
  resolveAssetUrl?: SlideAssetUrlResolver;
  currentSlideId?: string;
  renderMode?: "all" | "current";
  selectedBlockId?: string;
  onBlockSelect?: (selection: SlideBlockSelection) => void;
  className?: string;
  style?: CSSProperties;
};

const deckStyle: CSSProperties = {
  display: "grid",
  gap: 28,
  width: "100%",
  minWidth: 0,
  color: "var(--ink)"
};

const emptyDeckStyle: CSSProperties = {
  display: "grid",
  minHeight: 240,
  placeItems: "center",
  border: "1px solid var(--line)",
  borderRadius: "var(--lb-radius-stage)",
  background: "var(--panel)",
  color: "var(--muted)",
  fontWeight: 760
};

export function DeckRenderer({
  assets,
  className,
  currentSlideId,
  document,
  renderAsset,
  resolveAssetUrl,
  renderMode,
  selectedBlockId,
  onBlockSelect,
  style
}: DeckRendererProps) {
  const activeRenderMode = renderMode ?? (currentSlideId ? "current" : "all");
  const activeAssets = assets ?? document.assets;
  const slides = activeRenderMode === "current" ? currentSlide(document, currentSlideId) : document.slides;
  const showSlideNumber = document.deckSettings?.showSlideNumbers ?? true;

  if (document.slides.length === 0) {
    return (
      <section
        aria-label={document.title}
        className={["ld-deck-renderer", className].filter(Boolean).join(" ")}
        data-aspect={document.aspect}
        data-deck-id={document.id}
        data-default-transition={document.deckSettings?.defaultTransition ?? "slide"}
        data-mobile-mode={document.deckSettings?.mobileMode ?? "hybrid"}
        data-schema-version={document.schemaVersion}
        data-theme={document.theme}
        style={{ ...deckStyle, ...style }}
      >
        <div style={emptyDeckStyle}>Empty slide deck</div>
      </section>
    );
  }

  return (
    <section
      aria-label={document.title}
      className={["ld-deck-renderer", className].filter(Boolean).join(" ")}
      data-aspect={document.aspect}
      data-deck-id={document.id}
      data-default-transition={document.deckSettings?.defaultTransition ?? "slide"}
      data-mobile-mode={document.deckSettings?.mobileMode ?? "hybrid"}
      data-render-mode={activeRenderMode}
      data-schema-version={document.schemaVersion}
      data-theme={document.theme}
      style={{ ...deckStyle, ...style }}
    >
      {slides.map((slide) => {
        const slideIndex = document.slides.findIndex((candidate) => candidate.id === slide.id);

        return (
          <SlideRenderer
            aspect={document.aspect}
            assets={activeAssets}
            key={slide.id}
            renderAsset={renderAsset}
            resolveAssetUrl={resolveAssetUrl}
            selectedBlockId={selectedBlockId}
            showSlideNumber={showSlideNumber}
            slide={slide}
            slideCount={document.slides.length}
            slideNumber={slideIndex + 1}
            onBlockSelect={onBlockSelect}
          />
        );
      })}
    </section>
  );
}

function currentSlide(document: SlideDocument, currentSlideId: string | undefined) {
  if (!currentSlideId) return document.slides.slice(0, 1);
  return [document.slides.find((slide) => slide.id === currentSlideId) ?? document.slides[0]].filter(Boolean);
}
