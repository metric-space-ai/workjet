import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_MODEL } from "@workjet/contracts";
import type {
  WorkjetSupervisorExecutionEvent,
  WorkjetSupervisorPublicAssistantText,
  WorkjetSupervisorNativeMessageText,
} from "@workjet/contracts";
import {
  appendSupervisorExecutionEvents,
  reconstructSupervisorPublicReplies,
  reconstructSupervisorNativeMessageReplies,
  reconstructSupervisorReplies,
} from "./supervisorPublicReplies";

function event(
  id: string,
  chunk: Partial<WorkjetSupervisorPublicAssistantText> = {},
): WorkjetSupervisorExecutionEvent {
  return {
    id,
    sequence: 1,
    kind: "worker.assistant_text",
    title: "Assistant response",
    created_at_ms: 0,
    public_text: {
      turn_id: "turn",
      item_id: "item",
      phase: "final_answer",
      offset: 0,
      text: "Hello",
      completed: false,
      truncated: false,
      ...chunk,
    },
  };
}

describe("actual Supervisor public reply reconstruction", () => {
  it("keeps page duplicates idempotent while surfacing conflicting event identities", () => {
    const one = event("one");
    expect(appendSupervisorExecutionEvents([one], [structuredClone(one)])).toEqual({
      events: [one],
      limited: false,
      conflicted: false,
    });
    const conflict = appendSupervisorExecutionEvents([one], [event("one", { text: "Other" })]);
    expect(conflict.conflicted).toBe(true);
    expect(reconstructSupervisorPublicReplies("attempt", conflict.events)[0]).toMatchObject({
      text: "Hello",
      incomplete: true,
    });
  });
  it("bounds retained UI history without losing the last known native prefix", () => {
    const prefix = Array.from({ length: 4096 }, (_, index) => ({
      id: `event-${index}`,
      sequence: 1,
      kind: "worker.tool",
      title: "Tool result",
      created_at_ms: 0,
    }));
    expect(appendSupervisorExecutionEvents(prefix, [event("overflow")])).toEqual({
      events: prefix,
      limited: true,
      conflicted: false,
    });
    expect(appendSupervisorExecutionEvents(prefix, [prefix[0]!])).toEqual({
      events: prefix,
      limited: false,
      conflicted: false,
    });
  });
  it("keeps partial text across pages and counts Unicode offsets", () => {
    const events = [event("one", { text: "Hi 🦊" }), event("two", { offset: 4, text: "!" })];
    expect(reconstructSupervisorPublicReplies("attempt", events)).toMatchObject([
      { text: "Hi 🦊!", completed: false, incomplete: false },
    ]);
  });
  it("rebuilds the same retained text after reader reopen without a new turn", () => {
    const events = [
      event("one"),
      event("two", { offset: 5, text: " world" }),
      event("done", { offset: 11, text: "", completed: true }),
    ];
    expect(reconstructSupervisorPublicReplies("attempt", events)).toEqual(
      reconstructSupervisorPublicReplies("attempt", structuredClone(events)),
    );
    expect(reconstructSupervisorPublicReplies("attempt", events)[0]).toMatchObject({
      text: "Hello world",
      completed: true,
    });
  });
  it("deduplicates identical ledger events and matching overlapped chunks", () => {
    const one = event("one");
    expect(
      reconstructSupervisorPublicReplies("attempt", [
        one,
        one,
        event("overlap", { offset: 3, text: "lo!" }),
      ])[0],
    ).toMatchObject({ text: "Hello!", incomplete: false });
  });
  it("keeps a gap incomplete instead of appending uncorrelated text or completion", () => {
    expect(
      reconstructSupervisorPublicReplies("attempt", [
        event("one"),
        event("gap", { offset: 8, text: "tail", completed: true }),
      ])[0],
    ).toMatchObject({ text: "Hello", completed: false, incomplete: true });
  });
  it("rejects conflicting repeated event content", () => {
    expect(
      reconstructSupervisorPublicReplies("attempt", [
        event("one"),
        event("one", { text: "Other" }),
      ])[0],
    ).toMatchObject({ text: "Hello", incomplete: true });
  });
  it("separates provider turns and items, retaining the actual commentary phase", () => {
    const replies = reconstructSupervisorPublicReplies("attempt", [
      event("one", { phase: "commentary" }),
      event("two", { item_id: "answer", text: "Answer" }),
      event("three", { turn_id: "next-turn", text: "Next" }),
    ]);
    expect(replies.map((reply) => reply.text)).toEqual(["Hello", "Answer", "Next"]);
    expect(replies[0]?.phase).toBe("commentary");
    expect(new Set(replies.map((reply) => reply.id)).size).toBe(3);
    expect(reconstructSupervisorPublicReplies("new-attempt", [event("one")])[0]?.id).not.toBe(
      replies[0]?.id,
    );
  });
  it("marks native truncation without inventing task completion", () => {
    expect(
      reconstructSupervisorPublicReplies("attempt", [
        event("one"),
        event("limit", { offset: 5, text: "", truncated: true }),
      ])[0],
    ).toMatchObject({ text: "Hello", completed: false, truncated: true });
  });
  it("does not render tool titles or other event payloads as assistant replies", () => {
    expect(
      reconstructSupervisorPublicReplies("attempt", [
        { id: "tool", sequence: 1, kind: "worker.tool", title: "Tool result", created_at_ms: 0 },
      ]),
    ).toEqual([]);
  });
  it("does not accept new text after item completion", () => {
    expect(
      reconstructSupervisorPublicReplies("attempt", [
        event("done", { completed: true }),
        event("late", { offset: 5, text: "!" }),
      ])[0],
    ).toMatchObject({ text: "Hello", completed: true, incomplete: true });
  });
});

function nativeEvent(
  id: string,
  change: Partial<WorkjetSupervisorNativeMessageText> = {},
): WorkjetSupervisorExecutionEvent {
  return {
    id,
    sequence: 1,
    kind: "worker.native_message_text",
    title: "Native text",
    created_at_ms: 0,
    native_message_text: {
      execution_key: "execution",
      model_operation_id: "operation",
      native_message_id: "message",
      model: DEFAULT_MODEL,
      upstream_request_id: "request",
      offset: 0,
      text: "Hi 🦊",
      completed: false,
      ...change,
    },
  };
}
describe("native upstream Supervisor message reconstruction", () => {
  it("keeps actual native identities separate from SDK turns/items and resumes Unicode chunks", () => {
    const events = [nativeEvent("one"), nativeEvent("two", { offset: 4, text: "!" })];
    const reply = reconstructSupervisorNativeMessageReplies("attempt", events)[0];
    expect(reply).toMatchObject({
      source: "native-message",
      executionKey: "execution",
      modelOperationId: "operation",
      nativeMessageId: "message",
      upstreamRequestId: "request",
      model: DEFAULT_MODEL,
      text: "Hi 🦊!",
      completed: false,
      incomplete: false,
    });
    expect(reply).not.toHaveProperty("turnId");
    expect(reply).not.toHaveProperty("itemId");
    expect(reconstructSupervisorNativeMessageReplies("attempt", structuredClone(events))).toEqual([
      reply,
    ]);
  });
  it("deduplicates exact backfill and treats message stop only as message completion", () => {
    const one = nativeEvent("one");
    const replies = reconstructSupervisorNativeMessageReplies("attempt", [
      one,
      one,
      nativeEvent("done", { offset: 4, text: "", completed: true }),
    ]);
    expect(replies).toMatchObject([{ text: "Hi 🦊", completed: true, incomplete: false }]);
    expect(replies[0]).not.toHaveProperty("terminal");
  });
  it.each([
    { upstream_request_id: "foreign-request" },
    { offset: 7, text: "gap", completed: true },
    { offset: 0, text: "conflicting overlap" },
  ])("preserves the last prefix instead of merging a conflicting native chunk: %o", (change) => {
    expect(
      reconstructSupervisorNativeMessageReplies("attempt", [
        nativeEvent("one"),
        nativeEvent("two", change),
      ]),
    ).toMatchObject([{ text: "Hi 🦊", incomplete: true, completed: false }]);
  });
  it("marks both entries incomplete when a retained event changes native identity", () => {
    const events = [nativeEvent("same"), nativeEvent("same", { native_message_id: "other" })];
    expect(
      reconstructSupervisorNativeMessageReplies("attempt", events).map((reply) => reply.incomplete),
    ).toEqual([true, true]);
  });
  it("separates native executions, model operations and worker attempts", () => {
    const events = [
      nativeEvent("one"),
      nativeEvent("two", { model_operation_id: "other-operation" }),
      nativeEvent("three", { execution_key: "other-execution" }),
    ];
    const replies = reconstructSupervisorNativeMessageReplies("attempt", events);
    expect(new Set(replies.map((reply) => reply.id)).size).toBe(3);
    expect(reconstructSupervisorNativeMessageReplies("other-attempt", events)[0]?.id).not.toBe(
      replies[0]?.id,
    );
  });
  it("retains native/provider event order without converting native metadata", () => {
    const replies = reconstructSupervisorReplies("attempt", [
      nativeEvent("native"),
      event("provider", { text: "Provider reply" }),
      nativeEvent("next", { native_message_id: "next-message", text: "Next native reply" }),
    ]);
    expect(replies.map((reply) => reply.text)).toEqual([
      "Hi 🦊",
      "Provider reply",
      "Next native reply",
    ]);
  });
  it("rejects text appended after the upstream message ended", () => {
    expect(
      reconstructSupervisorNativeMessageReplies("attempt", [
        nativeEvent("done", { completed: true }),
        nativeEvent("late", { offset: 4, text: "!" }),
      ]),
    ).toMatchObject([{ text: "Hi 🦊", completed: true, incomplete: true }]);
  });
});
