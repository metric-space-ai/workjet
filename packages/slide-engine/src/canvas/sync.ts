// Workjet port of learnordie `src/lib/canvas-sync.ts` and the scene conversion of
// `StudioSlideDocumentEditor`/`ExcalidrawCanvas` (d94f8a59).
import { CANVAS_VERSION, type CanvasScene } from "../excalidraw/canvas-schema";
import type { CanvasAppState, CanvasFiles, CanvasRuntimeElement } from "./runtime";

/** Native and schema-normalized objects have different key order. Comparing
 * JSON.stringify directly echoes every native edit back into the engine and
 * interrupts its in-progress pointer/text state. Keep array order, sort keys. */
export function canvasFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

export function isCanvasGestureActive(state: CanvasAppState): boolean {
  // Image selection first inserts a placeholder, then asynchronously attaches
  // decoded bytes. Until placement finishes, it is not a persistable image.
  return (
    state.cursorButton === "down" ||
    Boolean(
      state.pendingImageElementId ||
      state.newElement ||
      state.editingTextElement ||
      state.resizingElement ||
      state.isResizing ||
      state.isRotating,
    )
  );
}

/** Cheap change key: Excalidraw bumps `version` on every element mutation. */
export function canvasChangeKey(
  elements: readonly CanvasRuntimeElement[],
  state: CanvasAppState,
): string {
  let versions = 0;
  for (const element of elements) versions += Number(element.version) || 0;
  return `${elements.length}:${versions}:${String(state.viewBackgroundColor)}`;
}

/**
 * Persistable `learnordie.excalidraw.v1` scene from native editor state: non-deleted elements,
 * only files used by visible images, frame size and background of the source scene.
 * Excalidraw retains unused files for undo; the runtime still owns that cache.
 */
export function toCanvasScene(
  source: Pick<CanvasScene, "width" | "height" | "backgroundColor">,
  elements: readonly CanvasRuntimeElement[],
  state: CanvasAppState,
  files: CanvasFiles,
): CanvasScene {
  const visible = elements.filter((element) => !element.isDeleted);
  const usedFiles = new Set(
    visible.filter((element) => element.type === "image").map((element) => element.fileId),
  );
  const scene = {
    version: CANVAS_VERSION,
    width: source.width,
    height: source.height,
    backgroundColor:
      typeof state.viewBackgroundColor === "string"
        ? state.viewBackgroundColor
        : source.backgroundColor,
    elements: visible,
    files: Object.fromEntries(Object.entries(files).filter(([id]) => usedFiles.has(id))),
  };
  // The native runtime includes optional fields with value undefined. Normalize to the
  // JSON boundary used by persistence; undefined is not a persisted element value.
  return JSON.parse(canvasFingerprint(scene)) as CanvasScene;
}

export type CanvasViewport = { zoom: number; scrollX: number; scrollY: number };

/** Viewport that shows the whole frame centred in a `width`×`height` canvas. */
export function frameViewport(
  width: number,
  height: number,
  frame: { width: number; height: number },
  margin = 1,
): CanvasViewport {
  const fit = Math.min(width / frame.width, height / frame.height) * margin;
  const zoom = Math.min(30, Math.max(0.1, Number.isFinite(fit) && fit > 0 ? fit : 1));
  return {
    zoom,
    scrollX: width / (2 * zoom) - frame.width / 2,
    scrollY: height / (2 * zoom) - frame.height / 2,
  };
}

export function viewportMatches(state: CanvasAppState, viewport: CanvasViewport): boolean {
  const zoom = Number((state.zoom as { value?: unknown } | undefined)?.value);
  return (
    Math.abs(zoom - viewport.zoom) < 1e-4 &&
    Math.abs(Number(state.scrollX) - viewport.scrollX) < 0.5 &&
    Math.abs(Number(state.scrollY) - viewport.scrollY) < 0.5
  );
}
