import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { CtoxWorkjetProjectControlRequest, CtoxWorkjetProjectControlResponse, isWorkjetSupervisorReceiptForRequest } from "./ctox.ts";
import { WorkjetSupervisorExecutionPage, WorkjetSupervisorExecutionPageRequest, nextWorkjetSupervisorExecutionPageRequest } from "./workjetSupervisorExecution.ts";

const threadId = "e28290b0-7b0a-4d19-a242-f27041fadb84";
const projectId = ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7");
const turn = { commandId: "native-command", taskId: "native-task", threadId, threadKey: `business-os/threads/${threadId}`, executionPhase: "running", status: "running", queueStatus: "running", attempt: 1, terminal: false, result: null, resultTruncated: false, errorCode: null, errorMessage: null };
const event = { id: "event-12", sequence: 12, kind: "worker.phase", title: "Recorded step", created_at_ms: 1791410400000 };
const page = { command_id: turn.commandId, task_id: turn.taskId, attempt: { attempt_id: "native-attempt", attempt_index: 47 }, events: [event], next_cursor: { after_sequence: 12, after_event_id: event.id }, has_more: true };
const request = { action: "project.supervisor.turn.watch", commandId: CommandId.make("observe-page"), projectId, threadId, targetCommandId: turn.commandId, executionPage: { attempt_id: page.attempt.attempt_id, limit: 25 } } as const;
const response = { action: request.action, commandId: request.commandId, projectId, contract: "ctox.workjet.supervisor_turn.v1", binding: { contract: "ctox.workjet.supervisor_binding.v1", projectId, threadId, threadKey: turn.threadKey }, turn, executionContract: "ctox.workjet.supervisor_execution.v1", executionPage: page } as const;
const decodeResponse = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, { onExcessProperty: "error" });
const decodePage = Schema.decodeUnknownSync(WorkjetSupervisorExecutionPage, { onExcessProperty: "error" });
const decodePageRequest = Schema.decodeUnknownSync(WorkjetSupervisorExecutionPageRequest, { onExcessProperty: "error" });

describe("native supervisor execution pages", () => {
  it("preserves optional actual run identity and the distinct attempt index", () => {
    const decoded = decodeResponse(response);
    expect(decoded).toEqual(response);
    expect(page.attempt.attempt_index).not.toBe(turn.attempt);
    expect(page.attempt).not.toHaveProperty("run_id");
    expect(decodePage({ ...page, attempt: { ...page.attempt, run_id: "actual-finalized-run" } }).attempt?.run_id).toBe("actual-finalized-run");
    expect(isWorkjetSupervisorReceiptForRequest(request, decoded)).toBe(true);
  });
  it("keeps the exact legacy shape and requires an explicit request for pages", () => {
    const { executionContract: _contract, executionPage: _page, ...legacy } = response;
    const { executionPage: _requestPage, ...legacyRequest } = request;
    expect(decodeResponse(legacy)).toEqual(legacy);
    expect(isWorkjetSupervisorReceiptForRequest(legacyRequest, legacy)).toBe(true);
    expect(isWorkjetSupervisorReceiptForRequest(legacyRequest, response)).toBe(false);
    expect(isWorkjetSupervisorReceiptForRequest(request, legacy)).toBe(false);
    expect(() => decodeResponse({ ...legacy, executionContract: response.executionContract })).toThrow();
  });
  it("rejects private tool payloads, unsafe counters and foreign command/task identities", () => {
    for (const changed of [
      { ...page, command_id: "foreign" }, { ...page, task_id: "foreign" },
      { ...page, events: [{ ...event, arguments: { secret: "private" } }] },
      { ...page, events: [{ ...event, sequence: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...page, events: [event, event] },
      { ...page, next_cursor: { after_sequence: 12, after_event_id: "foreign" } },
      { ...page, attempt: undefined },
    ]) expect(() => decodeResponse({ ...response, executionPage: changed })).toThrow();
    expect(isWorkjetSupervisorReceiptForRequest(request, { ...response, executionPage: { ...page, attempt: { attempt_id: "foreign" } } })).toBe(false);
  });
  it("anchors subsequent pages to the same actual attempt and last native event", () => {
    const next = nextWorkjetSupervisorExecutionPageRequest(page);
    expect(next).toEqual({ attempt_id: "native-attempt", cursor: page.next_cursor, limit: 25 });
    const nextRequest = { ...request, executionPage: next };
    const nextEvent = { ...event, id: "event-19", sequence: 19 };
    const nextPage = { ...page, events: [nextEvent], next_cursor: { after_sequence: 19, after_event_id: nextEvent.id }, has_more: false };
    expect(isWorkjetSupervisorReceiptForRequest(nextRequest, { ...response, executionPage: nextPage })).toBe(true);
    expect(isWorkjetSupervisorReceiptForRequest(nextRequest, response)).toBe(false);
    expect(isWorkjetSupervisorReceiptForRequest(nextRequest, { ...response, executionPage: { ...page, events: [], has_more: false } })).toBe(true);
    expect(isWorkjetSupervisorReceiptForRequest(nextRequest, { ...response, executionPage: { ...page, events: [], next_cursor: undefined, has_more: false } })).toBe(false);
  });
  it("accepts queued absence of an attempt and bounds observer-only fields", () => {
    expect(decodePage({ command_id: turn.commandId, task_id: turn.taskId, events: [], has_more: false })).not.toHaveProperty("attempt");
    expect(decodePageRequest({})).toEqual({});
    for (const changed of [{ limit: 0 }, { limit: 51 }, { attempt_id: " " }, { attempt_id: "\u0085" }, { owner_user_id: "foreign" }, { cursor: { after_sequence: 0, after_event_id: "x" } }]) expect(() => decodePageRequest(changed)).toThrow();
    const decodeRequest = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, { onExcessProperty: "error" });
    expect(() => decodeRequest({ ...request, action: "project.supervisor.turn.cancel" })).toThrow();
  });
});
