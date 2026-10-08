import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import {
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectControlResponse,
  isWorkjetJourFixeReceiptForRequest,
} from "./ctox.ts";

const base = {
  commandId: CommandId.make("meeting-command"),
  projectId: ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7"),
  operationId: "operation-1",
  meetingId: "meeting-1",
  expectedRevision: 4,
};
const start = { ...base, action: "project.jour_fixe.meeting.start" } as const;
const turn = {
  id: "turn-1",
  meeting_id: base.meetingId,
  sequence: 1,
  speaker: "owner",
  modality: "text",
  text: "Prioritize persistence.\nVerify the restart.",
  started_at_ms: 1791450011000,
  ended_at_ms: 1791450012000,
} as const;
const append = { ...base, action: "project.jour_fixe.transcript.append", turn } as const;
const revise = {
  ...base,
  action: "project.jour_fixe.todos.revise",
  proposalRevision: 2,
  items: [
    {
      id: "todo-1",
      title: "Verify restart",
      acceptance: "The project survives reopen.",
      priority: "P1",
      evidence_ids: [turn.id],
    },
  ],
} as const;
const comment = {
  ...base,
  action: "project.jour_fixe.comment.add",
  commentId: "pin-1",
  slideId: "slide-1",
  deckRevision: 1,
  x: 0.25,
  y: 0.75,
  text: "Check this assumption.",
} as const;
const response = {
  action: start.action,
  commandId: base.commandId,
  projectId: base.projectId,
  contract: "ctox.workjet.jour_fixe.v1",
  mutation: {
    operation_id: base.operationId,
    meeting_id: base.meetingId,
    project_id: base.projectId,
    revision: 5,
    state: "live",
  },
} as const;
const decodeRequest = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, {
  onExcessProperty: "error",
});
const decodeResponse = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, {
  onExcessProperty: "error",
});

describe("Jour fixe owner bridge", () => {
  it("carries all five native owner controls through the existing project control contract", () => {
    for (const request of [
      start,
      { ...base, action: "project.jour_fixe.meeting.end" },
      append,
      revise,
      comment,
    ])
      expect(decodeRequest(request)).toEqual(request);
    expect(decodeResponse(response)).toEqual(response);
    expect(isWorkjetJourFixeReceiptForRequest(start, response)).toBe(true);
  });
  it("does not allow owner text to claim a supervisor, speech, or another meeting", () => {
    for (const change of [
      { speaker: "supervisor" },
      { modality: "speech" },
      { meeting_id: "foreign" },
      { audio: {} },
      { stream_id: "fabricated" },
      { source_run_id: "fabricated" },
      { sentence_end_latency_ms: 100 },
      { ended_at_ms: turn.started_at_ms - 1 },
    ])
      expect(() => decodeRequest({ ...append, turn: { ...turn, ...change } })).toThrow();
  });
  it("rejects unsafe revisions and unbounded text or proposals", () => {
    for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER])
      expect(() => decodeRequest({ ...start, expectedRevision })).toThrow();
    expect(() =>
      decodeRequest({ ...append, turn: { ...turn, text: "a".repeat(16_385) } }),
    ).toThrow();
    expect(() => decodeRequest({ ...revise, items: Array(101).fill(revise.items[0]) })).toThrow();
    expect(() =>
      decodeRequest({
        ...revise,
        items: [{ ...revise.items[0], evidence_ids: Array(129).fill("turn-1") }],
      }),
    ).toThrow();
  });
  it("rejects cross-project and cross-operation receipts even when their action matches", () => {
    for (const changed of [
      { ...response, commandId: CommandId.make("other-command") },
      { ...response, projectId: ProjectId.make("foreign-project") },
      { ...response, mutation: { ...response.mutation, project_id: "foreign-project" } },
      { ...response, mutation: { ...response.mutation, meeting_id: "foreign-meeting" } },
      { ...response, mutation: { ...response.mutation, operation_id: "foreign-operation" } },
      { ...response, mutation: { ...response.mutation, revision: 4 } },
      { ...response, mutation: { ...response.mutation, revision: 6 } },
      { ...response, mutation: { ...response.mutation, state: "review" } },
    ])
      expect(isWorkjetJourFixeReceiptForRequest(start, changed)).toBe(false);
  });
  it("requires the acknowledged text id and the exact proposal revision", () => {
    const textReceipt = {
      ...response,
      action: append.action,
      mutation: { ...response.mutation, changed_id: turn.id },
    };
    expect(isWorkjetJourFixeReceiptForRequest(append, textReceipt)).toBe(true);
    expect(isWorkjetJourFixeReceiptForRequest(append, response)).toBe(false);
    expect(
      isWorkjetJourFixeReceiptForRequest(append, {
        ...textReceipt,
        mutation: { ...textReceipt.mutation, changed_id: "other-turn" },
      }),
    ).toBe(false);
    const todoReceipt = {
      ...response,
      action: revise.action,
      mutation: { ...response.mutation, state: "review", todos_revision: 2 },
    };
    expect(isWorkjetJourFixeReceiptForRequest(revise, todoReceipt)).toBe(true);
    expect(
      isWorkjetJourFixeReceiptForRequest(revise, {
        ...todoReceipt,
        mutation: { ...todoReceipt.mutation, todos_revision: 3 },
      }),
    ).toBe(false);
    expect(
      isWorkjetJourFixeReceiptForRequest(revise, {
        ...todoReceipt,
        mutation: { ...todoReceipt.mutation, state: "confirmed" },
      }),
    ).toBe(false);
  });
  it("accepts an exact replay receipt without inventing a second mutation", () => {
    expect(isWorkjetJourFixeReceiptForRequest(start, response)).toBe(true);
    expect(isWorkjetJourFixeReceiptForRequest({ ...start, expectedRevision: 5 }, response)).toBe(
      false,
    );
    const end = { ...base, action: "project.jour_fixe.meeting.end" } as const;
    expect(
      isWorkjetJourFixeReceiptForRequest(end, {
        ...response,
        action: end.action,
        mutation: { ...response.mutation, state: "review" },
      }),
    ).toBe(true);
  });
  it("requires a matching persisted pin and rejects forged identity or invalid coordinates", () => {
    const receipt = {
      ...response,
      action: comment.action,
      mutation: { ...response.mutation, changed_id: comment.commentId },
    };
    expect(isWorkjetJourFixeReceiptForRequest(comment, receipt)).toBe(true);
    for (const mutation of [
      { ...receipt.mutation, changed_id: "another-pin" },
      { ...receipt.mutation, state: "ready" },
      { ...receipt.mutation, revision: 6 },
    ])
      expect(isWorkjetJourFixeReceiptForRequest(comment, { ...receipt, mutation })).toBe(false);
    for (const change of [
      { x: -0.1 },
      { y: 1.1 },
      { x: Number.NaN },
      { y: Infinity },
      { deckRevision: 0.5 },
      { text: "a".repeat(4097) },
      { author_user_id: "forged" },
      { supervisor_event_id: "forged" },
    ])
      expect(() => decodeRequest({ ...comment, ...change })).toThrow();
  });
  it("leaves existing non-meeting project actions unchanged", () => {
    expect(isWorkjetJourFixeReceiptForRequest(null, response)).toBe(false);
    expect(isWorkjetJourFixeReceiptForRequest({}, response)).toBe(false);
    expect(
      isWorkjetJourFixeReceiptForRequest({ action: "project.list" }, { action: "project.list" }),
    ).toBe(true);
  });
});
