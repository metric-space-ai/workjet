import { describe, expect, it, vi } from "vitest";
import * as Schema from "effect/Schema";
import { ProjectId, WorkjetJourFixeMeeting, type CtoxWorkjetProjectControlRequest, type CtoxWorkjetProjectControlResult } from "@workjet/contracts";
import fixture from "../../../../packages/contracts/src/workjetJourFixeMeeting.fixture.json";
import { requestWorkjetProjectControl } from "../workjetProjectControl";
import { JourFixeNativeSession, mapJourFixeMeeting } from "./jourFixeNative";
const native = Schema.decodeUnknownSync(WorkjetJourFixeMeeting)(fixture.valid_cases.find((item) => item.type === "Meeting")!.value);
const project = Schema.decodeUnknownSync(ProjectId)(native.project_id);
const snapshot = mapJourFixeMeeting(native);
function reply(request: CtoxWorkjetProjectControlRequest, revision = 4): CtoxWorkjetProjectControlResult {
 if (request.action === "project.jour_fixe.meeting.read") return { _tag: "completed", response: { ...request, contract: "ctox.workjet.jour_fixe.v1", meeting: { ...native, revision } } };
 if ("operationId" in request && "meetingId" in request && "expectedRevision" in request) return { _tag: "completed", response: {
  action: request.action, commandId: request.commandId, projectId: request.projectId, contract: "ctox.workjet.jour_fixe.v1",
  mutation: { operation_id: request.operationId, meeting_id: request.meetingId, project_id: request.projectId, revision: request.expectedRevision + 1,
   state: request.action === "project.jour_fixe.meeting.start" ? "live" : "review",
   ...(request.action === "project.jour_fixe.transcript.append" ? { changed_id: request.turn.id } : {}),
   ...(request.action === "project.jour_fixe.todos.revise" ? { todos_revision: request.proposalRevision } : {}),
  } } };
 return { _tag: "failed", code: "unsupported" };
}
describe("native meeting room session", () => {
 it("maps authority metadata without treating audio file references as URLs", () => {
  expect(snapshot).toMatchObject({ id: native.id, projectId: native.project_id, previousGoalRevision: 2, state: "review", deckRevision: 1 });
  expect(snapshot.slides[0]).toMatchObject({ markdown: native.slides[0]!.body_markdown });
  expect(snapshot.slides[0]).not.toHaveProperty("audio");
  expect(snapshot.todos!.items[0]!.evidenceIds).toEqual(["comment-1","turn-1"]);
 });
 it("retries uncertain text using the same command, operation, turn and expected revision", async () => {
  const control = vi.fn<typeof requestWorkjetProjectControl>().mockResolvedValueOnce({ _tag: "failed", code: "timeout" }).mockImplementation(async (_,request) => reply(request));
  const session = new JourFixeNativeSession("instance-1",project,() => true,control);
  await expect(session.text(snapshot,"Owner message")).rejects.toThrow("not been confirmed");
  await session.text({ ...snapshot, revision: 99 },"Owner message");
  expect(control.mock.calls[1]![1]).toEqual(control.mock.calls[0]![1]);
  expect(control.mock.calls[0]![1]).toMatchObject({ expectedRevision: 3, turn: { speaker: "owner", modality: "text", sequence: 2 } });
  expect(control.mock.calls[2]![1]).toMatchObject({ action: "project.jour_fixe.meeting.read", meetingId: native.id });
 });
 it("does not write again after an acknowledged mutation when only its subsequent read failed", async () => {
  const control = vi.fn<typeof requestWorkjetProjectControl>().mockImplementationOnce(async (_,request) => reply(request)).mockResolvedValueOnce({ _tag: "failed", code: "timeout" }).mockImplementation(async (_,request) => reply(request));
  const session = new JourFixeNativeSession("instance-1",project,() => true,control);
  await expect(session.end(native.id,3)).rejects.toThrow("timeout");
  await session.end(native.id,3);
  expect(control.mock.calls.map((call) => call[1].action)).toEqual(["project.jour_fixe.meeting.end","project.jour_fixe.meeting.read","project.jour_fixe.meeting.read"]);
 });
 it("blocks other mutations while an uncertain intent remains", async () => {
  const control = vi.fn<typeof requestWorkjetProjectControl>().mockResolvedValue({ _tag: "failed", code: "timeout" });
  const session = new JourFixeNativeSession("instance-1",project,() => true,control);
  await expect(session.end(native.id,3)).rejects.toThrow();
  await expect(session.text(snapshot,"different")).rejects.toThrow("Retry the unconfirmed");
  expect(control).toHaveBeenCalledTimes(1);
 });
 it("submits the next proposal revision and keeps source evidence", async () => {
  const control = vi.fn<typeof requestWorkjetProjectControl>().mockImplementation(async (_,request) => reply(request));
  const session = new JourFixeNativeSession("instance-1",project,() => true,control);
  await session.revise(native.id,3,1,snapshot.todos!.items);
  expect(control.mock.calls[0]![1]).toMatchObject({ action: "project.jour_fixe.todos.revise", proposalRevision: 2, items: [{ evidence_ids: ["comment-1","turn-1"] }] });
 });
 it("rejects late reads after an instance switch, before the UI can consume them", async () => {
  let current = true;
  const control = vi.fn<typeof requestWorkjetProjectControl>().mockImplementation(async (_,request) => { current = false; return reply(request); });
  const session = new JourFixeNativeSession("instance-1",project,() => current,control);
  await expect(session.read()).rejects.toThrow("scope changed");
 });
 it("rejects a read of another meeting even from the selected guest", async () => {
  const control = vi.fn<typeof requestWorkjetProjectControl>().mockImplementation(async (_,request) => reply(request));
  const session = new JourFixeNativeSession("instance-1",project,() => true,control);
  await expect(session.read("foreign")).rejects.toThrow("not confirmed");
 });
});
