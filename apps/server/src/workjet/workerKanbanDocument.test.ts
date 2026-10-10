import { createHash } from "node:crypto";
import { ThreadId, WorkjetWorkerKanban, WorkjetWorkerKanbanSlideDocument } from "@workjet/contracts";
import { parseSlideDocument } from "@workjet/slide-engine/schema";
import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { createWorkerKanbanSlideDocument } from "./workerKanbanDocument.ts";

const kanban: WorkjetWorkerKanban = {
  goalRevision: 2,
  iteration: 3,
  updatedAt: "2026-10-10T01:30:00.000Z",
  cards: [
    { id: "plan", title: "Plan the next verified step", status: "todo" },
    { id: "test", title: "Run the acceptance", status: "doing", evidence: "Run receipt pending" },
    { id: "lease", title: "Obtain the execution lease", status: "blocked", evidence: "Owner action" },
    { id: "source", title: "Ship the source", status: "done", evidence: "Merged PR" },
  ],
};
const input = {
  threadId: ThreadId.make("persistent-parent"),
  title: "Parent delivery",
  objective: "Deliver the approved project outcome.",
  kanban,
};
function decode(snapshot: WorkjetWorkerKanbanSlideDocument) {
  return parseSlideDocument(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(snapshot.documentJson));
}

it("produces a canonical meeting-readable board and a digest of the persisted bytes", () => {
  const snapshot = createWorkerKanbanSlideDocument(input);
  expect(Schema.decodeUnknownSync(WorkjetWorkerKanbanSlideDocument)(snapshot)).toEqual(snapshot);
  const document = decode(snapshot);
  const table = document.slides[0]!.blocks.find((block) => block.type === "table");
  expect(table?.type).toBe("table");
  if (table?.type !== "table") throw new Error("missing board");
  expect(table.columns).toEqual(["To do", "Doing", "Blocked", "Done"]);
  expect(table.rows).toEqual([[
    "Plan the next verified step", "Run the acceptance\nRun receipt pending",
    "Obtain the execution lease\nOwner action", "Ship the source\nMerged PR",
  ]]);
  expect(table.mobileStrategy).toBe("cards");
  expect(document.slides[0]!.sourceRefs[0]!.locator).toContain("goal revision 2 · iteration 3");
  expect(document.createdBy).toEqual({ mode: "import" });
  expect(snapshot.sha256).toBe(createHash("sha256").update(snapshot.documentJson).digest("hex"));
  expect(createWorkerKanbanSlideDocument(input)).toEqual(snapshot);
});

it("validates an empty board and does not invent a done card", () => {
  const document = decode(createWorkerKanbanSlideDocument({
    ...input, kanban: { ...kanban, cards: [] },
  }));
  expect(document.slides).toHaveLength(1);
  expect(document.slides[0]!.blocks.some((block) => block.type === "table")).toBe(false);
  expect(document.slides[0]!.blocks).toContainEqual(expect.objectContaining({
    type: "callout", text: "No cards recorded for this iteration.",
  }));
});

it("paginates the maximum board and validates bounded Unicode without altering source cards", () => {
  const large = Schema.decodeUnknownSync(WorkjetWorkerKanban)({
    ...kanban,
    cards: Array.from({ length: 30 }, (_, index) => ({
      id: "card-" + index,
      title: "😀".repeat(256),
      evidence: "😀".repeat(1000),
      status: "todo",
    })),
  });
  const before = Schema.encodeSync(Schema.fromJsonString(WorkjetWorkerKanban))(large);
  const objective = "😀".repeat(2048);
  const snapshot = createWorkerKanbanSlideDocument({
    ...input, threadId: ThreadId.make("Parent / ü"), title: "😀".repeat(300), objective, kanban: large,
  });
  const document = decode(snapshot);
  expect(document.slides).toHaveLength(6);
  const tables = document.slides.flatMap((slide) => slide.blocks.filter((block) => block.type === "table"));
  expect(tables.every((table) => table.rows.length === 5)).toBe(true);
  expect(tables.flatMap((table) => table.rows).length).toBe(30);
  expect(tables.flatMap((table) => table.rows).flat().every((cell) => cell.length <= 400 && !/[\uD800-\uDBFF]$/.test(cell))).toBe(true);
  expect(document.slides[0]!.speakerNotes!.map((note) => note.text).join("")).toBe(objective);
  expect(Schema.encodeSync(Schema.fromJsonString(WorkjetWorkerKanban))(large)).toBe(before);
});

it("accepts valid objectives with whitespace-only note chunks", () => {
  const objective = "Start" + " ".repeat(3200) + "finish";
  const document = decode(createWorkerKanbanSlideDocument({ ...input, objective }));
  expect(document.slides[0]!.speakerNotes!.every((note) => note.text.trim().length > 0)).toBe(true);
  expect(document.slides[0]!.speakerNotes!.map((note) => note.text).join(" ")).toContain("finish");
});

it("keeps iteration identity stable while edits change the digest, and scopes identity by thread", () => {
  const first = createWorkerKanbanSlideDocument(input);
  const edited = createWorkerKanbanSlideDocument({
    ...input, kanban: { ...kanban, cards: [{ ...kanban.cards[0]!, status: "done" }] },
  });
  expect(decode(first).id).toBe(decode(edited).id);
  expect(first.sha256).not.toBe(edited.sha256);
  for (const next of [
    { ...input, threadId: ThreadId.make("other-parent") },
    { ...input, kanban: { ...kanban, goalRevision: kanban.goalRevision + 1 } },
    { ...input, kanban: { ...kanban, iteration: kanban.iteration + 1 } },
  ]) expect(decode(createWorkerKanbanSlideDocument(next)).id).not.toBe(decode(first).id);
});
