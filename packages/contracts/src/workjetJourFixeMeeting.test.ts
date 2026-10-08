import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import fixture from "./workjetJourFixeMeeting.fixture.json" with { type: "json" };
import {
  WorkjetJourFixeMeeting,
  WorkjetJourFixeReadResponse,
  isWorkjetJourFixeReadReceiptForRequest,
} from "./workjetJourFixeMeeting.ts";
const decode = Schema.decodeUnknownSync(WorkjetJourFixeMeeting, { onExcessProperty: "error" });
const meeting = fixture.valid_cases.find((item) => item.type === "Meeting")!.value;
const request = {
  action: "project.jour_fixe.meeting.read",
  commandId: "read-1",
  projectId: "project-1",
};
const response = { ...request, contract: "ctox.workjet.jour_fixe.v1", meeting };
describe("native Jour fixe meeting read", () => {
  it("accepts the canonical native review and confirmed fixtures", () => {
    for (const item of fixture.valid_cases.filter((item) => item.type === "Meeting"))
      expect(() => decode(item.value)).not.toThrow();
  });
  it("reads current native task owners and explicit local narration custody metadata", () => {
    const native = decode(meeting);
    const current = { ...native,
      todos: { ...native.todos!, items: native.todos!.items.map((todo) => ({ ...todo, owner: "Project supervisor" })) },
      slides: native.slides.map((slide) => ({ ...slide, audio: { ...slide.audio!, provenance: "authenticated_owner_local_audio", generation_id: "native-frozen-generation" } })),
    };
    expect(decode(current).todos!.items[0]!.owner).toBe("Project supervisor");
    expect(isWorkjetJourFixeReadReceiptForRequest(request, { ...response, meeting: current })).toBe(true);
    expect(() => decode({ ...current, slides: current.slides.map((slide) => ({ ...slide, audio: { ...slide.audio, provenance: "forged_provider" } })) })).toThrow();
  });
  it("accepts explicit null only on optional wire metadata", () => {
    const native = decode(meeting);
    const nullable = {
      ...native,
      previous_goal: null,
      error: null,
      slides: native.slides.map((slide) => ({ ...slide, audio: null })),
      comments: native.comments.map((comment) => ({ ...comment, supervisor_event_id: null })),
      transcript: native.transcript.map((turn) => ({
        ...turn,
        source_run_id: null,
        audio: null,
        stream_id: null,
        sentence_end_latency_ms: null,
      })),
      todos: native.todos
        ? {
            ...native.todos,
            goal: null,
            confirmed_by_user_id: null,
            confirmed_at_ms: null,
            items: native.todos.items.map((todo) => ({ ...todo, due_at_ms: null })),
          }
        : null,
    };
    expect(() => decode(nullable)).not.toThrow();
    expect(
      isWorkjetJourFixeReadReceiptForRequest(request, { ...response, meeting: nullable }),
    ).toBe(true);
    expect(() => decode({ ...nullable, owner_user_id: null })).toThrow();
    expect(() => decode({ ...nullable, supervisor: null })).toThrow();
  });
  it("rejects the canonical invalid Meeting wire fixtures", () => {
    for (const item of fixture.invalid_cases.filter((item) => item.type === "Meeting"))
      expect(() => decode(item.value)).toThrow();
  });
  it("correlates command, project and explicit meeting; only implicit absence is allowed", () => {
    expect(isWorkjetJourFixeReadReceiptForRequest(request, response)).toBe(true);
    expect(
      isWorkjetJourFixeReadReceiptForRequest(request, { ...response, commandId: "other" }),
    ).toBe(false);
    expect(
      isWorkjetJourFixeReadReceiptForRequest(request, { ...response, projectId: "other" }),
    ).toBe(false);
    expect(
      isWorkjetJourFixeReadReceiptForRequest({ ...request, meetingId: "other" }, response),
    ).toBe(false);
    expect(isWorkjetJourFixeReadReceiptForRequest(request, { ...response, meeting: null })).toBe(
      true,
    );
    expect(
      isWorkjetJourFixeReadReceiptForRequest(
        { ...request, meetingId: "meeting-1" },
        { ...response, meeting: null },
      ),
    ).toBe(false);
  });
  it("rejects cross-meeting children, unsupported timezones and unsafe revisions", () => {
    const native = decode(meeting);
    expect(
      isWorkjetJourFixeReadReceiptForRequest(request, {
        ...response,
        meeting: { ...native, slides: [{ ...native.slides[0], meeting_id: "foreign" }] },
      }),
    ).toBe(false);
    expect(
      isWorkjetJourFixeReadReceiptForRequest(request, {
        ...response,
        meeting: { ...native, timezone: "not/a-zone" },
      }),
    ).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(WorkjetJourFixeReadResponse)({
        ...response,
        meeting: { ...native, revision: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow();
  });
});
