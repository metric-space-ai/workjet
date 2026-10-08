import type {
  CtoxWorkjetProjectControlRequest,
  ProjectId,
  WorkjetJourFixeMeeting,
  WorkjetJourFixeReadResponse,
} from "@workjet/contracts";
import {
  isWorkjetJourFixeReceiptForRequest,
  isWorkjetJourFixeReadReceiptForRequest,
} from "@workjet/contracts";
import { requestWorkjetProjectControl } from "../workjetProjectControl";
import { newCommandId, randomUUID } from "./utils";
import type { JourFixeCommentDraft, JourFixeRoomSnapshot, JourFixeTodo } from "./jourFixeRoom";

type MutationRequest = Extract<
  CtoxWorkjetProjectControlRequest,
  { operationId: string; meetingId: string; expectedRevision: number }
>;
type Control = typeof requestWorkjetProjectControl;

/** Metadata is mapped for display; an AudioRef never becomes a playable URL. */
export function mapJourFixeMeeting(meeting: WorkjetJourFixeMeeting): JourFixeRoomSnapshot {
  return {
    id: meeting.id,
    projectId: meeting.project_id,
    revision: meeting.revision,
    deckRevision: meeting.deck_revision,
    state: meeting.state,
    scheduledAt: meeting.scheduled_at_ms,
    timezone: meeting.timezone,
    ...(meeting.previous_goal ? { previousGoalRevision: meeting.previous_goal.revision } : {}),
    slides: meeting.slides.map((slide) => ({
      id: slide.id,
      position: slide.position,
      title: slide.title,
      markdown: slide.body_markdown,
    })),
    comments: meeting.comments.map((comment) => ({
      id: comment.id,
      slideId: comment.slide_id,
      deckRevision: comment.deck_revision,
      x: comment.x,
      y: comment.y,
      text: comment.text,
    })),
    transcript: meeting.transcript.map((turn) => ({
      id: turn.id,
      sequence: turn.sequence,
      speaker: turn.speaker,
      text: turn.text,
      ...(turn.stream_id ? { streamId: turn.stream_id } : {}),
    })),
    ...(meeting.todos
      ? {
          todos: {
            revision: meeting.todos.revision,
            status: meeting.todos.status,
            items: meeting.todos.items.map((todo) => ({
              id: todo.id,
              title: todo.title,
              acceptance: todo.acceptance,
              priority: todo.priority,
              evidenceIds: todo.evidence_ids,
              ...(todo.due_at_ms === undefined ? {} : { dueAt: todo.due_at_ms }),
            })),
          },
        }
      : {}),
    ...(meeting.error ? { error: meeting.error } : {}),
  };
}

/** One visible room owns one immutable instance/project scope and uncertain intent. */
export class JourFixeNativeSession {
  private pending:
    | { key: string; request: MutationRequest; acknowledgedRevision?: number }
    | undefined;
  private closed = false;
  constructor(
    readonly instanceId: string,
    readonly projectId: ProjectId,
    private readonly current: () => boolean,
    private readonly control: Control = requestWorkjetProjectControl,
  ) {}
  close() {
    this.closed = true;
  }
  hasPendingChange() {
    return this.pending !== undefined;
  }
  retryPending() {
    if (!this.pending) throw new Error("No change is waiting for retry.");
    const pending = this.pending;
    return this.mutate(pending.key, () => pending.request);
  }
  private assertCurrent() {
    if (this.closed || !this.current()) throw new Error("Meeting scope changed.");
  }
  async read(meetingId?: string): Promise<WorkjetJourFixeReadResponse> {
    this.assertCurrent();
    const request = {
      action: "project.jour_fixe.meeting.read" as const,
      commandId: newCommandId(),
      projectId: this.projectId,
      ...(meetingId ? { meetingId } : {}),
    };
    const result = await this.control(this.instanceId, request);
    this.assertCurrent();
    if (result._tag !== "completed") throw new Error(`Meeting unavailable: ${result.code}`);
    if (
      result.response.action !== request.action ||
      !isWorkjetJourFixeReadReceiptForRequest(request, result.response)
    )
      throw new Error("Meeting read was not confirmed.");
    return result.response;
  }
  private async mutate(
    key: string,
    build: () => MutationRequest,
  ): Promise<WorkjetJourFixeReadResponse> {
    this.assertCurrent();
    if (this.pending && this.pending.key !== key)
      throw new Error("Retry the unconfirmed change before making another change.");
    const pending: { key: string; request: MutationRequest; acknowledgedRevision?: number } = this
      .pending ?? { key, request: build() };
    this.pending = pending;
    if (pending.acknowledgedRevision === undefined) {
      const result = await this.control(this.instanceId, pending.request);
      this.assertCurrent();
      if (
        result._tag !== "completed" ||
        !isWorkjetJourFixeReceiptForRequest(pending.request, result.response) ||
        !("mutation" in result.response)
      )
        throw new Error(
          "This change has not been confirmed. Retry preserves its operation identity.",
        );
      pending.acknowledgedRevision = result.response.mutation.revision;
    }
    const fresh = await this.read(pending.request.meetingId);
    if (fresh.meeting === null || fresh.meeting.revision < pending.acknowledgedRevision)
      throw new Error("The confirmed meeting snapshot is still catching up.");
    this.pending = undefined;
    return fresh;
  }
  private fields(meetingId: string, expectedRevision: number) {
    return {
      commandId: newCommandId(),
      operationId: randomUUID(),
      projectId: this.projectId,
      meetingId,
      expectedRevision,
    };
  }
  start(meetingId: string, revision: number) {
    return this.mutate(`start:${meetingId}`, () => ({
      action: "project.jour_fixe.meeting.start",
      ...this.fields(meetingId, revision),
    }));
  }
  end(meetingId: string, revision: number) {
    return this.mutate(`end:${meetingId}`, () => ({
      action: "project.jour_fixe.meeting.end",
      ...this.fields(meetingId, revision),
    }));
  }
  text(meeting: JourFixeRoomSnapshot, text: string) {
    return this.mutate(JSON.stringify(["text", meeting.id, text]), () => {
      const now = Date.now();
      return {
        action: "project.jour_fixe.transcript.append",
        ...this.fields(meeting.id, meeting.revision),
        turn: {
          id: randomUUID(),
          meeting_id: meeting.id,
          sequence: Math.max(0, ...meeting.transcript.map((turn) => turn.sequence)) + 1,
          speaker: "owner",
          modality: "text",
          text,
          started_at_ms: now,
          ended_at_ms: now,
        },
      };
    });
  }
  comment(draft: JourFixeCommentDraft, text: string) {
    return this.mutate(JSON.stringify(["comment", draft, text]), () => ({
      action: "project.jour_fixe.comment.add",
      ...this.fields(draft.meetingId, draft.expectedRevision),
      commentId: randomUUID(),
      slideId: draft.slideId,
      deckRevision: draft.deckRevision,
      x: draft.x,
      y: draft.y,
      text,
    }));
  }
  revise(
    meetingId: string,
    revision: number,
    proposalRevision: number,
    items: readonly JourFixeTodo[],
  ) {
    return this.mutate(JSON.stringify(["todos", meetingId, items]), () => ({
      action: "project.jour_fixe.todos.revise",
      ...this.fields(meetingId, revision),
      proposalRevision: proposalRevision + 1,
      items: items.map((todo) => ({
        id: todo.id,
        title: todo.title,
        acceptance: todo.acceptance,
        priority: todo.priority,
        evidence_ids: [...todo.evidenceIds],
        ...(todo.dueAt === undefined ? {} : { due_at_ms: todo.dueAt }),
      })),
    }));
  }
}
