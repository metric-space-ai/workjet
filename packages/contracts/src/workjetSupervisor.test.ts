import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { CtoxWorkjetProjectControlRequest, CtoxWorkjetProjectControlResponse, isWorkjetSupervisorReceiptForRequest } from "./ctox.ts";
import { WorkjetSupervisorGoal, WorkjetSupervisorJournal } from "./workjetSupervisor.ts";

const threadId = "e28290b0-7b0a-4d19-a242-f27041fadb84";
const projectId = ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7");
const binding = { contract: "ctox.workjet.supervisor_binding.v1", projectId, threadId, threadKey: `business-os/threads/${threadId}` } as const;
const turn = { commandId: "native-turn-1", taskId: "task-1", threadId, threadKey: binding.threadKey, executionPhase: "queued", status: "pending", queueStatus: "queued", attempt: 0, terminal: false, result: null, resultTruncated: false, errorCode: null, errorMessage: null } as const;
const request = { action: "project.supervisor.turn.watch", commandId: CommandId.make("observe-1"), projectId, threadId, targetCommandId: turn.commandId } as const;
const response = { action: request.action, commandId: request.commandId, projectId, contract: "ctox.workjet.supervisor_turn.v1", binding, turn } as const;

describe("native Workjet supervisor contract", () => {
  it("carries the actual task and attempt facts without synthesizing a run id", () => {
    const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, { onExcessProperty: "error" });
    expect(decode(response)).toEqual(response);
    expect(() => decode({ ...response, turn: { ...turn, runId: "invented" } })).toThrow();
    expect(() => decode({ ...response, turn: { ...turn, terminal: true } })).toThrow();
    expect(() => decode({ ...response, binding: { ...binding, threadKey: "foreign" } })).toThrow();
  });
  it("correlates the guest receipt with the requested project, thread and execution", () => {
    expect(isWorkjetSupervisorReceiptForRequest(request, response)).toBe(true);
    for (const changed of [
      { ...response, commandId: CommandId.make("other-observation") },
      { ...response, projectId: ProjectId.make("other-project") },
      { ...response, turn: { ...turn, commandId: "other-execution" } },
      { ...response, binding: { ...binding, threadId: "6f688cca-f01b-4e08-ac6e-d91c9c512d5b" } },
    ]) expect(isWorkjetSupervisorReceiptForRequest(request, changed)).toBe(false);
  });
  it("uses the native UTF-8 goal limit and rejects watch-only extra fields", () => {
    const goal = Schema.decodeUnknownSync(WorkjetSupervisorGoal);
    expect(goal("A multiline goal\nwith context.")).toContain("\n");
    expect(() => goal("ä".repeat(2049))).toThrow();
    expect(() => goal("bad\0goal")).toThrow();
    const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, { onExcessProperty: "error" });
    expect(() => decode({ ...request, reason: "not valid for watch" })).toThrow();
  });
  it("persists a submission intent separately from native observations", () => {
    const journal = { intent: { instanceId: "managed:acceptance", projectId, threadId, commandId: CommandId.make("submit-1"), goal: "Do the real project change.", createdAt: "2026-10-07T21:00:00.000Z" }, turn };
    expect(Schema.decodeUnknownSync(WorkjetSupervisorJournal)(journal)).toEqual(journal);
    expect(() => Schema.decodeUnknownSync(WorkjetSupervisorJournal)({ ...journal, turn: { ...turn, threadId: "6f688cca-f01b-4e08-ac6e-d91c9c512d5b", threadKey: "business-os/threads/6f688cca-f01b-4e08-ac6e-d91c9c512d5b" } })).toThrow();
  });
});
