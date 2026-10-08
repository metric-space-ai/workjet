import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import fixture from "./workjetJourFixeMeeting.fixture.json";
import { WorkjetJourFixeMeeting, WorkjetJourFixeReadResponse, isWorkjetJourFixeReadReceiptForRequest } from "./workjetJourFixeMeeting.ts";
const decode = Schema.decodeUnknownSync(WorkjetJourFixeMeeting, { onExcessProperty: "error" });
const meeting = fixture.valid_cases.find((item) => item.type === "Meeting")!.value;
const request = { action: "project.jour_fixe.meeting.read", commandId: "read-1", projectId: "project-1" };
const response = { ...request, contract: "ctox.workjet.jour_fixe.v1", meeting };
describe("native Jour fixe meeting read", () => {
 it("accepts the canonical native review and confirmed fixtures", () => {
  for (const item of fixture.valid_cases.filter((item) => item.type === "Meeting")) expect(() => decode(item.value)).not.toThrow();
 });
 it("rejects the canonical invalid Meeting wire fixtures", () => {
  for (const item of fixture.invalid_cases.filter((item) => item.type === "Meeting")) expect(() => decode(item.value)).toThrow();
 });
 it("correlates command, project and explicit meeting; only implicit absence is allowed", () => {
  expect(isWorkjetJourFixeReadReceiptForRequest(request,response)).toBe(true);
  expect(isWorkjetJourFixeReadReceiptForRequest(request,{ ...response, commandId: "other" })).toBe(false);
  expect(isWorkjetJourFixeReadReceiptForRequest(request,{ ...response, projectId: "other" })).toBe(false);
  expect(isWorkjetJourFixeReadReceiptForRequest({ ...request, meetingId: "other" },response)).toBe(false);
  expect(isWorkjetJourFixeReadReceiptForRequest(request,{ ...response, meeting: null })).toBe(true);
  expect(isWorkjetJourFixeReadReceiptForRequest({ ...request, meetingId: "meeting-1" },{ ...response, meeting: null })).toBe(false);
 });
 it("rejects cross-meeting children, unsupported timezones and unsafe revisions", () => {
  const native = decode(meeting);
  expect(isWorkjetJourFixeReadReceiptForRequest(request,{ ...response, meeting: { ...native, slides: [{ ...native.slides[0], meeting_id: "foreign" }] } })).toBe(false);
  expect(isWorkjetJourFixeReadReceiptForRequest(request,{ ...response, meeting: { ...native, timezone: "not/a-zone" } })).toBe(false);
  expect(() => Schema.decodeUnknownSync(WorkjetJourFixeReadResponse)({ ...response, meeting: { ...native, revision: Number.MAX_SAFE_INTEGER + 1 } })).toThrow();
 });
});
