import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  WorkjetSupervisorExecutionPage,
  WorkjetSupervisorExecutionPageRequest,
  WorkjetSupervisorPublicAssistantText,
  nextWorkjetSupervisorExecutionPageRequest,
} from "./workjetSupervisorExecution.ts";

const decodePage = Schema.decodeUnknownSync(WorkjetSupervisorExecutionPage);
const decodeText = Schema.decodeUnknownSync(WorkjetSupervisorPublicAssistantText);
const decodeRequest = Schema.decodeUnknownSync(WorkjetSupervisorExecutionPageRequest);

const chunk = {
  turn_id: "turn",
  item_id: "item",
  phase: "final_answer",
  offset: 0,
  text: "Public answer 🦊",
  completed: false,
  truncated: false,
} as const;
const page = {
  command_id: "command",
  task_id: "task",
  attempt: { attempt_id: "attempt" },
  events: [
    {
      id: "event",
      sequence: 1,
      kind: "worker.assistant_text",
      title: "Assistant response",
      created_at_ms: 0,
      public_text: chunk,
    },
  ],
  next_cursor: { after_sequence: 1, after_event_id: "event" },
  has_more: false,
  public_text_supported: true,
};

describe("native Supervisor public-text opt-in wire", () => {
  it("accepts actual bounded native text only on opted-in pages", () => {
    expect(
      decodeRequest({
        include_public_text: true,
      }),
    ).toEqual({ include_public_text: true });
    expect(decodePage(page)).toEqual(page);
  });
  it("uses native Unicode-character bounds rather than UTF16 code-unit length", () => {
    expect(
      decodeText({
        ...chunk,
        text: "🦊".repeat(4096),
      }).text,
    ).toHaveLength(8192);
    expect(() =>
      decodeText({
        ...chunk,
        text: "🦊".repeat(4097),
      }),
    ).toThrow();
  });
  it("rejects private/tool phases and out-of-range offsets", () => {
    for (const invalid of [
      { ...chunk, phase: "reasoning" },
      { ...chunk, offset: 65537 },
      { ...chunk, offset: -1 },
    ])
      expect(() => decodeText(invalid)).toThrow();
  });
  it("rejects text on unrelated event kinds or without native support", () => {
    expect(() =>
      decodePage({
        ...page,
        events: [{ ...page.events[0], kind: "worker.tool" }],
      }),
    ).toThrow();
    expect(() =>
      decodePage({
        ...page,
        public_text_supported: false,
      }),
    ).toThrow();
    expect(() =>
      decodePage({
        ...page,
        events: [{ ...page.events[0], public_text: undefined }],
      }),
    ).toThrow();
  });
  it("retains the opt-in and actual attempt/cursor for continuation", () => {
    expect(nextWorkjetSupervisorExecutionPageRequest(decodePage(page))).toEqual({
      attempt_id: "attempt",
      cursor: page.next_cursor,
      limit: 25,
      include_public_text: true,
    });
  });
  it("keeps legacy and unsupported pages explicit without fabricated replies", () => {
    expect(
      decodePage({
        command_id: "command",
        task_id: "task",
        events: [],
        has_more: false,
      }),
    ).toEqual({ command_id: "command", task_id: "task", events: [], has_more: false });
    expect(
      decodePage({
        command_id: "command",
        task_id: "task",
        events: [],
        has_more: false,
        public_text_supported: false,
      }).public_text_supported,
    ).toBe(false);
  });
});
