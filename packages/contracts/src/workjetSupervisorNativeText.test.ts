import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { DEFAULT_MODEL } from "./index.ts";
import {
  WorkjetSupervisorExecutionPage,
  WorkjetSupervisorExecutionPageRequest,
  WorkjetSupervisorNativeMessageText,
  isWorkjetSupervisorExecutionPageForRequest,
  nextWorkjetSupervisorExecutionPageRequest,
} from "./workjetSupervisorExecution.ts";
import type { WorkjetSupervisorTurn } from "./workjetSupervisor.ts";

const decodePage = Schema.decodeUnknownSync(WorkjetSupervisorExecutionPage, { onExcessProperty: "error" });
const decodeText = Schema.decodeUnknownSync(WorkjetSupervisorNativeMessageText, { onExcessProperty: "error" });
const decodeRequest = Schema.decodeUnknownSync(WorkjetSupervisorExecutionPageRequest, { onExcessProperty: "error" });
const chunk = {
  execution_key: "native-execution", model_operation_id: "native-operation",
  native_message_id: "upstream-message", model: DEFAULT_MODEL, upstream_request_id: "upstream-request",
  offset: 0, text: "Native answer 🦊", completed: false,
};
const page = {
  command_id: "command", task_id: "task", attempt: { attempt_id: "attempt" },
  events: [{
    id: "event", sequence: 1, kind: "worker.native_message_text", title: "Native message text",
    created_at_ms: 0, native_message_text: chunk,
  }],
  next_cursor: { after_sequence: 1, after_event_id: "event" },
  has_more: false, native_message_text_supported: true,
};
it("accepts only the typed native message identities and explicit support", () => {
  expect(decodeText(chunk)).toEqual(chunk);
  expect(decodePage(page)).toEqual(page);
  expect(decodeRequest({ include_native_message_text: true })).toEqual({ include_native_message_text: true });
  expect(() => decodeText({ ...chunk, turn_id: "sdk-turn" })).toThrow();
  expect(() => decodeText({ ...chunk, native_message_id: "" })).toThrow();
});
it("preserves Unicode offsets and native text limits", () => {
  expect(decodeText({ ...chunk, text: "🦊".repeat(4096), offset: 65536 }).text).toHaveLength(8192);
  expect(() => decodeText({ ...chunk, text: "🦊".repeat(4097) })).toThrow();
  expect(() => decodeText({ ...chunk, offset: 65537 })).toThrow();
  expect(() => decodeText({ ...chunk, offset: -1 })).toThrow();
});
it.each([
  { ...page, native_message_text_supported: false },
  { ...page, native_message_text_supported: undefined },
  { ...page, events: [{ ...page.events[0], kind: "worker.tool" }] },
  { ...page, events: [{ ...page.events[0], native_message_text: undefined }] },
])("rejects text without its actual event/support contract: %o", (invalid) => {
  expect(() => decodePage(invalid)).toThrow();
});
it("retains the actual attempt/cursor and independent text opt-ins when paging", () => {
  expect(nextWorkjetSupervisorExecutionPageRequest(decodePage(page))).toEqual({
    attempt_id: "attempt", cursor: page.next_cursor, limit: 25, include_native_message_text: true,
  });
  expect(nextWorkjetSupervisorExecutionPageRequest(decodePage({ ...page, public_text_supported: true })))
    .toMatchObject({ include_public_text: true, include_native_message_text: true });
});
it("does not accept unsolicited native support or a foreign task/attempt", () => {
  const turn: WorkjetSupervisorTurn = {
    commandId: "command", taskId: "task", threadId: "fixture-thread",
    threadKey: "business-os/threads/fixture-thread", executionPhase: "running", status: "running",
    queueStatus: "running", attempt: 1, terminal: false, result: null, resultTruncated: false,
    errorCode: null, errorMessage: null,
  };
  expect(isWorkjetSupervisorExecutionPageForRequest({}, turn, page)).toBe(false);
  expect(isWorkjetSupervisorExecutionPageForRequest({ include_native_message_text: true }, turn, page)).toBe(true);
  expect(isWorkjetSupervisorExecutionPageForRequest({ include_native_message_text: true, attempt_id: "other" }, turn, page))
    .toBe(false);
  expect(isWorkjetSupervisorExecutionPageForRequest({ include_native_message_text: true }, turn, { ...page, task_id: "other" }))
    .toBe(false);
});
