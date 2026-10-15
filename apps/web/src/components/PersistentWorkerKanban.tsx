import { useMemo } from "react";
import { Schema } from "effect";
import type { WorkjetWorkerKanbanSlideDocument } from "@workjet/contracts";
import { SlideRenderer } from "@workjet/slide-engine/components";
import { parseSlideDocument } from "@workjet/slide-engine/schema";
import "@workjet/slide-engine/styles/core.css";
import "@workjet/slide-engine/styles/themes/learnordie-dark-room.css";

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

/** Draw only the canonical persisted document, never reconstruct progress from legacy cards. */
export default function PersistentWorkerKanban({
  snapshot,
}: {
  readonly snapshot: WorkjetWorkerKanbanSlideDocument;
}) {
  const document = useMemo(() => {
    try {
      return parseSlideDocument(decodeJson(snapshot.documentJson));
    } catch {
      return null;
    }
  }, [snapshot.documentJson]);
  if (!document) return <p role="alert">Das gespeicherte Mini-Kanban ist ungültig.</p>;
  return (
    <div
      className="ld-deck-renderer grid gap-2"
      data-theme="learnordie-dark-room"
      data-workjet-worker-kanban={snapshot.sha256}
    >
      {document.slides.map((slide, index) => (
        <SlideRenderer
          key={slide.id}
          slide={slide}
          assets={document.assets}
          aspect={document.aspect}
          showSlideNumber={document.slides.length > 1}
          slideNumber={index + 1}
          slideCount={document.slides.length}
          style={{ aspectRatio: "auto", padding: "12px", boxShadow: "none" }}
        />
      ))}
    </div>
  );
}
