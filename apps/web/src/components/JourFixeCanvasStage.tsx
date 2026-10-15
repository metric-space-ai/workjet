import { useEffect, useState } from "react";
import { loadCanvasRuntime, SlideCanvas, type CanvasRuntime } from "@workjet/slide-engine/canvas";
import type { CanvasScene } from "@workjet/slide-engine/excalidraw/canvas-schema";
import type { SlideDocument } from "@workjet/slide-engine/schema";
import "@workjet/slide-engine/styles/core.css";
import { Button } from "./ui/button";
import {
  JOUR_FIXE_CANVAS_LANG_CODE,
  JOUR_FIXE_CANVAS_MESSAGES,
} from "../lib/jourFixeCanvasMessages";

/** Feste deutsche Zeile; der Rohtext der Engine bleibt in der Konsole. */
export const JOUR_FIXE_SLIDE_LOAD_FAILED = "Folie nicht geladen";

export interface JourFixeCanvasStageProps {
  readonly document: SlideDocument;
  readonly slideId: string;
  readonly mode: "present" | "edit";
  /** Folge dem App-Schema: Tafel im Dunklen, Papier im Hellen. */
  readonly theme?: "light" | "dark";
  /** Edit mode only: the slide's scene after each change. */
  readonly onSceneChange: (scene: CanvasScene) => void;
  /** Edit mode only: reads the editor's scene immediately (see `SlideCanvas`). */
  readonly captureRef: { current: (() => CanvasScene | null) | null };
}

const RUNTIME_BASE = `${import.meta.env.BASE_URL}vendor/excalidraw/`;

/**
 * One slide of a Regeltermin presentation: the hand-drawn canvas with its 3D scenes.
 * The meeting stage owns edit mode and saving; this component only draws the slide.
 */
export default function JourFixeCanvasStage({
  document,
  slideId,
  mode,
  theme = "light",
  onSceneChange,
  captureRef,
}: JourFixeCanvasStageProps) {
  const [runtime, setRuntime] = useState<CanvasRuntime | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const slide = document.slides.find((item) => item.id === slideId);

  useEffect(() => {
    let alive = true;
    loadCanvasRuntime({ assetBaseUrl: RUNTIME_BASE, messages: JOUR_FIXE_CANVAS_MESSAGES }).then(
      (value) => {
        if (alive) {
          setRuntime(value);
          setLoadFailed(false);
        }
      },
      (reason: unknown) => {
        if (!alive) return;
        console.warn("Regeltermin-Folie nicht geladen", reason);
        setLoadFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  if (!slide) return null;
  return (
    <div className="absolute inset-0" data-workjet-presentation-stage={mode}>
      {runtime ? (
        <SlideCanvas
          key={slideId}
          runtime={runtime}
          slide={slide}
          assets={document.assets}
          mode={mode}
          theme={theme}
          langCode={JOUR_FIXE_CANVAS_LANG_CODE}
          onSceneChange={onSceneChange}
          captureRef={captureRef}
          className="absolute inset-0"
        />
      ) : (
        <div
          role="status"
          className="absolute inset-0 grid place-items-center px-6 text-center text-[13.5px] text-stage-muted"
        >
          {loadFailed ? (
            <div className="flex items-center gap-2">
              <span>{JOUR_FIXE_SLIDE_LOAD_FAILED}</span>
              <Button size="sm" variant="outline" onClick={() => setAttempt((count) => count + 1)}>
                Erneut versuchen
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
