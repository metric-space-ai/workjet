// Layout rules for `SlideCanvas`, ported from learnordie `src/app/ui-excalidraw.css` (d94f8a59).
// Injected once at runtime so the canvas works without a CSS import in the host app; scene
// controls still need the engine's `styles/core.css`.
const STYLE_ID = "workjet-slide-canvas-css";

const CSS = `
.workjet-slide-canvas { position: relative; display: grid; place-items: center; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.workjet-slide-canvas[data-mode="present"] { background: var(--workjet-slide-canvas-letterbox, #e9e7e1); }
.workjet-slide-canvas[data-mode="present"][data-theme="dark"] { background: var(--workjet-slide-canvas-letterbox-dark, #0e0f11); }
.workjet-slide-canvas__stage { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.workjet-slide-canvas__host { position: absolute; inset: 0; }
.workjet-slide-canvas__host > div { width: 100%; height: 100%; }
.workjet-slide-canvas .excalidraw .HintViewer { display: none; }
.workjet-slide-canvas[data-mode="present"] .excalidraw :is(.layer-ui__wrapper, .App-bottom-bar, .FixedSideContainer, .excalidraw__embeddable-hint) { display: none; }
/* Presentations do not need the editor's first-click-to-activate embed gate. */
.workjet-slide-canvas[data-mode="present"] .excalidraw__embeddable-container__inner:has(.learnordie-canvas-embed-host) { pointer-events: all !important; }
.workjet-slide-canvas .excalidraw-hyperlinkContainer:has(a[href^="https://learnordie.invalid/embed/"]) { display: none; }
/* Excalidraw inverts its drawing canvas in dark mode, but three.js renders its own colors. */
.workjet-slide-canvas .excalidraw.theme--dark .learnordie-canvas-scene canvas { filter: none; }
.workjet-slide-canvas .excalidraw__embeddable-container__inner:has(.learnordie-canvas-scene) { background: transparent !important; }
.learnordie-canvas-scene .lb-scene3d { height: 100%; min-height: 0; border: 0; border-radius: 0; font-size: 24px; }
.learnordie-canvas-scene .lb-scene3d-stage { flex: 1 1 0; min-height: 80px; aspect-ratio: auto; }
.learnordie-canvas-scene .lb-scene3d-controls { flex: 0 0 auto; max-height: 58%; overflow: auto; padding: 12px 16px; font-size: 22px; }
.learnordie-canvas-scene .lb-scene3d-tool { min-height: 36px; padding: 6px 4px; background: transparent; color: inherit; font-size: 22px; }
.workjet-slide-canvas__transcript { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
`;

export function ensureCanvasStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}
