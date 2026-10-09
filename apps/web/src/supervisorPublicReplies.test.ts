import { describe, expect, it } from "vitest";
import type { WorkjetSupervisorExecutionEvent, WorkjetSupervisorPublicAssistantText } from "@workjet/contracts";
import { appendSupervisorExecutionEvents, reconstructSupervisorPublicReplies } from "./supervisorPublicReplies";

function event(id: string, chunk: Partial<WorkjetSupervisorPublicAssistantText> = {}): WorkjetSupervisorExecutionEvent {
  return { id, sequence: 1, kind: "worker.assistant_text", title: "Assistant response", created_at_ms: 0,
    public_text: { turn_id: "turn", item_id: "item", phase: "final_answer", offset: 0,
      text: "Hello", completed: false, truncated: false, ...chunk } };
}

describe("actual Supervisor public reply reconstruction", () => {
  it("keeps page duplicates idempotent while surfacing conflicting event identities", () => {
    const one = event("one");
    expect(appendSupervisorExecutionEvents([one], [structuredClone(one)])).toEqual({ events: [one], limited: false, conflicted: false });
    const conflict = appendSupervisorExecutionEvents([one], [event("one", { text: "Other" })]);
    expect(conflict.conflicted).toBe(true);
    expect(reconstructSupervisorPublicReplies("attempt", conflict.events)[0]).toMatchObject({ text: "Hello", incomplete: true });
  });
  it("bounds retained UI history without losing the last known native prefix", () => {
    const prefix = Array.from({ length: 4096 }, (_, index) => ({ ...event(`event-${index}`), kind: "worker.tool", public_text: undefined }));
    expect(appendSupervisorExecutionEvents(prefix, [event("overflow")])).toEqual({ events: prefix, limited: true, conflicted: false });
    expect(appendSupervisorExecutionEvents(prefix, [prefix[0]!])).toEqual({ events: prefix, limited: false, conflicted: false });
  });
  it("keeps partial text across pages and counts Unicode offsets", () => {
    const events = [event("one", { text: "Hi 🦊" }), event("two", { offset: 4, text: "!" })];
    expect(reconstructSupervisorPublicReplies("attempt", events)).toMatchObject([
      { text: "Hi 🦊!", completed: false, incomplete: false },
    ]);
  });
  it("rebuilds the same retained text after reader reopen without a new turn", () => {
    const events = [event("one"), event("two", { offset: 5, text: " world" }),
      event("done", { offset: 11, text: "", completed: true })];
    expect(reconstructSupervisorPublicReplies("attempt", events)).toEqual(
      reconstructSupervisorPublicReplies("attempt", structuredClone(events)),
    );
    expect(reconstructSupervisorPublicReplies("attempt", events)[0]).toMatchObject({ text: "Hello world", completed: true });
  });
  it("deduplicates identical ledger events and matching overlapped chunks", () => {
    const one = event("one");
    expect(reconstructSupervisorPublicReplies("attempt", [one, one, event("overlap", { offset: 3, text: "lo!" })])[0])
      .toMatchObject({ text: "Hello!", incomplete: false });
  });
  it("keeps a gap incomplete instead of appending uncorrelated text or completion", () => {
    expect(reconstructSupervisorPublicReplies("attempt", [event("one"),
      event("gap", { offset: 8, text: "tail", completed: true })])[0])
      .toMatchObject({ text: "Hello", completed: false, incomplete: true });
  });
  it("rejects conflicting repeated event content", () => {
    expect(reconstructSupervisorPublicReplies("attempt", [event("one"), event("one", { text: "Other" })])[0])
      .toMatchObject({ text: "Hello", incomplete: true });
  });
  it("separates provider turns and items, retaining the actual commentary phase", () => {
    const replies = reconstructSupervisorPublicReplies("attempt", [event("one", { phase: "commentary" }),
      event("two", { item_id: "answer", text: "Answer" }), event("three", { turn_id: "next-turn", text: "Next" })]);
    expect(replies.map(reply => reply.text)).toEqual(["Hello", "Answer", "Next"]);
    expect(replies[0]?.phase).toBe("commentary");
    expect(new Set(replies.map(reply => reply.id)).size).toBe(3);
    expect(reconstructSupervisorPublicReplies("new-attempt", [event("one")])[0]?.id).not.toBe(replies[0]?.id);
  });
  it("marks native truncation without inventing task completion", () => {
    expect(reconstructSupervisorPublicReplies("attempt", [event("one"), event("limit", { offset: 5, text: "", truncated: true })])[0])
      .toMatchObject({ text: "Hello", completed: false, truncated: true });
  });
  it("does not render tool titles or other event payloads as assistant replies", () => {
    expect(reconstructSupervisorPublicReplies("attempt", [{ ...event("tool"), kind: "worker.tool", public_text: undefined }]))
      .toEqual([]);
  });
  it("does not accept new text after item completion", () => {
    expect(reconstructSupervisorPublicReplies("attempt", [event("done", { completed: true }), event("late", { offset: 5, text: "!" })])[0])
      .toMatchObject({ text: "Hello", completed: true, incomplete: true });
  });
});
