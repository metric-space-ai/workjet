import { useEffect, useState } from "react";
import { loadCanvasRuntime, SlideCanvas, type CanvasRuntime } from "@workjet/slide-engine/canvas";
import type { CanvasScene } from "@workjet/slide-engine/excalidraw/canvas-schema";
import type { SlideDocument } from "@workjet/slide-engine/schema";
import "@workjet/slide-engine/styles/core.css";
import { Button } from "./ui/button";

export interface JourFixeCanvasStageProps {
  readonly document: SlideDocument;
  readonly slideId: string;
  readonly mode: "present" | "edit";
  /** Edit mode only: the slide's scene after each change. */
  readonly onSceneChange: (scene: CanvasScene) => void;
}

const RUNTIME_BASE = `${import.meta.env.BASE_URL}vendor/excalidraw/`;

/**
 * One slide of a Jour fixe presentation: the hand-drawn canvas with its 3D scenes.
 * The meeting stage owns edit mode and saving; this component only draws the slide.
 */
export default function JourFixeCanvasStage({
  document,
  slideId,
  mode,
  onSceneChange,
}: JourFixeCanvasStageProps) {
  const [runtime, setRuntime] = useState<CanvasRuntime | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const slide = document.slides.find((item) => item.id === slideId);

  useEffect(() => {
    let alive = true;
    loadCanvasRuntime({ assetBaseUrl: RUNTIME_BASE }).then(
      (value) => {
        if (alive) {
          setRuntime(value);
          setLoadError(null);
        }
      },
      (reason: unknown) => {
        if (alive) setLoadError(reason instanceof Error ? reason.message : String(reason));
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
          theme="light"
          langCode="en"
          onSceneChange={onSceneChange}
          className="absolute inset-0"
        />
      ) : (
        <div
          role="status"
          className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-[#52525b]"
        >
          {loadError ? (
            <div className="grid justify-items-center gap-3">
              <p>The slide canvas could not load: {loadError}</p>
              <Button
                size="sm"
                variant="outline"
                className="border-[#d4d4d8] bg-white text-[#18181b] hover:bg-white"
                onClick={() => setAttempt((count) => count + 1)}
              >
                Try again
              </Button>
            </div>
          ) : (
            "Loading the slide…"
          )}
        </div>
      )}
    </div>
  );
}
