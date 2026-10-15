// Excalidraw canvas layer: present and edit `slide.canvas` scenes with the vendored runtime.
// Usage: `const runtime = await loadCanvasRuntime({ assetBaseUrl: "/vendor/excalidraw/" })`, then
// render `<SlideCanvas runtime={runtime} … />`. Import the engine's `styles/core.css` once for the
// 3D scene controls. `./runtime` must stay the first module this entry loads (zod CSP setting).
export {
  CANVAS_EMBED_LINK_PREFIX,
  defaultCanvasRuntimeMessages,
  isCanvasEmbedLink,
  loadCanvasRuntime,
} from "./runtime";
export type {
  CanvasAppState,
  CanvasFiles,
  CanvasImperativeAPI,
  CanvasMount,
  CanvasRuntime,
  CanvasRuntimeElement,
  CanvasRuntimeMessages,
  CanvasRuntimeProps,
  LoadCanvasRuntimeOptions,
} from "./runtime";
export { parseCanvasEmbed, renderCanvasEmbeddable } from "./CanvasEmbed";
export type { CanvasEmbedData } from "./CanvasEmbed";
export { SlideCanvas } from "./SlideCanvas";
export type {
  SlideAsset,
  SlideCanvasMode,
  SlideCanvasProps,
  SlideCanvasTheme,
} from "./SlideCanvas";
