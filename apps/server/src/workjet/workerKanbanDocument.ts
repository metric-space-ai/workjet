import { createHash } from "node:crypto";
import type {
  ThreadId,
  WorkjetWorkerKanban,
  WorkjetWorkerKanbanSlideDocument,
} from "@workjet/contracts";
import { parseSlideDocument, SLIDE_DOCUMENT_SCHEMA_VERSION } from "@workjet/slide-engine/schema";
import * as Schema from "effect/Schema";

const columns = [
  ["todo", "To do"],
  ["doing", "Doing"],
  ["blocked", "Blocked"],
  ["done", "Done"],
] as const;
const rowsPerSlide = 5;

function compact(text: string, limit: number): string {
  const value = text.trim();
  return value.length <= limit
    ? value
    : value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

/** Canonical display snapshot of reported cards; never a verified progress receipt. */
export function createWorkerKanbanSlideDocument(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly objective: string;
  readonly kanban: WorkjetWorkerKanban;
}): WorkjetWorkerKanbanSlideDocument {
  const { kanban } = input;
  const key = createHash("sha256")
    .update(input.threadId + "\0" + kanban.goalRevision + "\0" + kanban.iteration)
    .digest("hex")
    .slice(0, 24);
  const groups = columns.map(([status]) => kanban.cards.filter((card) => card.status === status));
  const rows = Array.from({ length: Math.max(...groups.map((group) => group.length)) }, (_, row) =>
    groups.map((group) => {
      const card = group[row];
      return card
        ? compact(card.title, 180) + (card.evidence ? "\n" + compact(card.evidence, 190) : "")
        : "";
    }),
  );
  const goalPoints = Array.from(input.objective);
  const notes = Array.from({ length: Math.ceil(goalPoints.length / 800) }, (_, index) => ({
    id: "goal-note-" + index + "-" + key,
    kind: "talkingPoint" as const,
    text: goalPoints.slice(index * 800, (index + 1) * 800).join("").trim(),
  })).filter((note) => note.text.length > 0);
  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerSlide));
  const title = input.title.trim() || "Persistent worker";
  const document = parseSlideDocument({
    schemaVersion: SLIDE_DOCUMENT_SCHEMA_VERSION,
    id: "parent-kanban-" + key,
    title: compact(title, 180),
    language: "en",
    aspect: "16:9",
    theme: "learnordie-dark-room",
    deckSettings: {
      defaultTransition: "none",
      showSlideNumbers: pageCount > 1,
      allowFragments: false,
      mobileMode: "reflow",
    },
    slides: Array.from({ length: pageCount }, (_, page) => ({
      id: "board-" + page + "-" + key,
      title: compact(title, 140),
      layout: "table_focus",
      intent: "summary",
      blocks: [
        { id: "objective-" + key, type: "paragraph", text: compact(input.objective, 1200) },
        ...(rows.length > 0
          ? [{
              id: "cards-" + key,
              type: "table",
              columns: columns.map(([, label]) => label),
              rows: rows.slice(page * rowsPerSlide, (page + 1) * rowsPerSlide),
              mobileStrategy: "cards",
              caption: "Reported plan and evidence · updated " + kanban.updatedAt,
            }]
          : [{
              id: "empty-" + key,
              type: "callout",
              tone: "info",
              text: "No cards recorded for this iteration.",
            }]),
      ],
      speakerNotes: notes,
      sourceRefs: [{
        id: "source-" + key,
        sourceType: "import",
        label: "Durable parent mini-kanban",
        locator: compact(
          "Thread " + input.threadId + " · goal revision " + kanban.goalRevision
            + " · iteration " + kanban.iteration,
          180,
        ),
      }],
    })),
    assets: [],
    createdBy: { mode: "import" },
  });
  const documentJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(document);
  return {
    schemaVersion: SLIDE_DOCUMENT_SCHEMA_VERSION,
    documentJson,
    sha256: createHash("sha256").update(documentJson).digest("hex"),
  };
}
