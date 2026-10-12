import { memo, useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageInlineProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

/**
 * Vergrößertes Bild inline im Chat (kein Lightbox-Overlay): das Bild steht
 * über dem Composer in Spaltenbreite; ein Klick schaltet zwischen „passend“
 * und voller Breite. Pfeiltasten blättern, Escape schließt.
 */
export const ExpandedImageInline = memo(function ExpandedImageInline({
  preview,
  onClose,
}: ExpandedImageInlineProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [fullWidth, setFullWidth] = useState(false);
  const count = preview.images.length;
  const index = (preview.index + imageOffset + count) % count;

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (count <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigateImage(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        navigateImage(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [count, navigateImage, onClose]);

  const item = preview.images[index];
  if (!item) return null;

  return (
    <figure
      className="mx-auto mb-2 flex w-full max-w-5xl flex-col gap-1.5 rounded-lg border bg-card/40 p-2"
      data-expanded-image-inline="true"
    >
      <div className="flex min-w-0 items-center gap-1">
        <figcaption className="min-w-0 flex-1 truncate px-1 text-muted-foreground text-xs">
          {item.name}
          {count > 1 ? ` (${index + 1}/${count})` : ""}
        </figcaption>
        {count > 1 ? (
          <>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Vorheriges Bild"
              title="Vorheriges Bild"
              onClick={() => navigateImage(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Nächstes Bild"
              title="Nächstes Bild"
              onClick={() => navigateImage(1)}
            >
              <ChevronRightIcon />
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Bild schließen"
          title="Schließen"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className={cn("min-w-0", fullWidth ? "overflow-x-auto" : "overflow-hidden")}>
        <button
          type="button"
          className={cn("block", fullWidth ? "cursor-zoom-out" : "mx-auto cursor-zoom-in")}
          aria-label={fullWidth ? "Bild einpassen" : "Volle Breite"}
          aria-pressed={fullWidth}
          onClick={() => setFullWidth((current) => !current)}
        >
          <img
            src={item.src}
            alt={item.name}
            draggable={false}
            className={cn(
              "select-none rounded-md object-contain",
              fullWidth ? "w-full max-w-none" : "max-h-[50vh] max-w-full",
            )}
          />
        </button>
      </div>
    </figure>
  );
});
