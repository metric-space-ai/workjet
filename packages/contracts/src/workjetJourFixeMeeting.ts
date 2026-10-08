// Wire fields from ctox.workjet.jour_fixe.v1 (CTOX #401/#409).

import * as Schema from "effect/Schema";

import { CommandId, ProjectId } from "./baseSchemas.ts";

const text = (n: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(n));

const unsigned = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));

export const WorkjetJourFixeSupervisorRef = Schema.Struct({
  workjet_thread_id: text(128),
  ctox_thread_key: text(512),
});

export const WorkjetJourFixeMeetingState = Schema.Literals(["planned", "preparing", "ready", "live", "review", "confirmed", "cancelled", "failed"]);

export const WorkjetJourFixeGoalRef = Schema.Struct({
  goal_id: text(128),
  revision: unsigned,
});

export const WorkjetJourFixeAudioRef = Schema.Struct({
  file_id: text(128),
  sha256: text(64) .check(Schema.isMinLength(64)),
  mime_type: text(128),
  duration_ms: unsigned,
  narration_text_sha256: text(64) .check(Schema.isMinLength(64)),
  source_run_id: text(128),
  model: text(128),
  format: text(32),
  synthesis_duration_ms: unsigned,
});

export const WorkjetJourFixeSlide = Schema.Struct({
  id: text(128),
  position: unsigned,
  title: text(256),
  body_markdown: text(16384),
  audio: Schema.optionalKey(WorkjetJourFixeAudioRef),
  meeting_id: text(128),
});

export const WorkjetJourFixeComment = Schema.Struct({
  id: text(128),
  slide_id: text(128),
  deck_revision: unsigned,
  x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  text: text(4096),
  author_user_id: text(256),
  created_at_ms: unsigned,
  supervisor_event_id: Schema.optionalKey(text(128)),
  meeting_id: text(128),
});

export const WorkjetJourFixeSpeaker = Schema.Literals(["owner", "supervisor"]);

export const WorkjetJourFixeModality = Schema.Literals(["text", "speech"]);

export const WorkjetJourFixeTranscriptTurn = Schema.Struct({
  id: text(128),
  sequence: unsigned,
  speaker: WorkjetJourFixeSpeaker,
  modality: WorkjetJourFixeModality,
  text: text(16384),
  started_at_ms: unsigned,
  ended_at_ms: unsigned,
  source_run_id: Schema.optionalKey(text(128)),
  audio: Schema.optionalKey(WorkjetJourFixeAudioRef),
  stream_id: Schema.optionalKey(text(128)),
  sentence_end_latency_ms: Schema.optionalKey(unsigned),
  meeting_id: text(128),
});

export const WorkjetJourFixeTodoState = Schema.Literals(["proposed", "confirmed", "superseded"]);

export const WorkjetJourFixePriority = Schema.Literals(["P0", "P1", "P2"]);

export const WorkjetJourFixeTodo = Schema.Struct({
  id: text(128),
  title: text(512),
  acceptance: text(4096),
  priority: WorkjetJourFixePriority,
  evidence_ids: Schema.Array(text(128)).check(Schema.isMaxLength(128)),
  due_at_ms: Schema.optionalKey(unsigned),
});

export const WorkjetJourFixeTodoList = Schema.Struct({
  revision: unsigned,
  status: WorkjetJourFixeTodoState,
  items: Schema.Array(WorkjetJourFixeTodo).check(Schema.isMaxLength(100)),
  confirmed_by_user_id: Schema.optionalKey(text(256)),
  confirmed_at_ms: Schema.optionalKey(unsigned),
  goal: Schema.optionalKey(WorkjetJourFixeGoalRef),
  meeting_id: text(128),
});

export const WorkjetJourFixeMeeting = Schema.Struct({
  id: text(128),
  project_id: text(128),
  owner_user_id: text(256),
  supervisor: WorkjetJourFixeSupervisorRef,
  scheduled_at_ms: unsigned,
  prepare_at_ms: unsigned,
  timezone: text(128),
  state: WorkjetJourFixeMeetingState,
  revision: unsigned,
  deck_revision: unsigned,
  previous_goal: Schema.optionalKey(WorkjetJourFixeGoalRef),
  slides: Schema.Array(WorkjetJourFixeSlide).check(Schema.isMaxLength(100)),
  comments: Schema.Array(WorkjetJourFixeComment).check(Schema.isMaxLength(1000)),
  transcript: Schema.Array(WorkjetJourFixeTranscriptTurn).check(Schema.isMaxLength(10000)),
  todos: Schema.optionalKey(WorkjetJourFixeTodoList),
  error: Schema.optionalKey(text(4096)),
});

export type WorkjetJourFixeMeeting = typeof WorkjetJourFixeMeeting.Type;


export const WorkjetJourFixeReadRequest = Schema.Struct({
 action: Schema.Literal("project.jour_fixe.meeting.read"), commandId: CommandId.check(Schema.isMaxLength(128)),
 projectId: ProjectId.check(Schema.isMaxLength(128)), meetingId: Schema.optionalKey(text(128)),
});
export type WorkjetJourFixeReadRequest = typeof WorkjetJourFixeReadRequest.Type;
export const WorkjetJourFixeReadResponse = Schema.Struct({
 action: Schema.Literal("project.jour_fixe.meeting.read"), commandId: CommandId,
 projectId: ProjectId, contract: Schema.Literal("ctox.workjet.jour_fixe.v1"),
 meeting: Schema.NullOr(WorkjetJourFixeMeeting), preparationTaskId: Schema.optionalKey(text(256)),
}).check(Schema.makeFilter((value) => value.meeting === null || value.meeting.project_id === value.projectId));
export type WorkjetJourFixeReadResponse = typeof WorkjetJourFixeReadResponse.Type;
const decodeReadRequest = Schema.decodeUnknownSync(WorkjetJourFixeReadRequest, { onExcessProperty: "error" });
const decodeReadResponse = Schema.decodeUnknownSync(WorkjetJourFixeReadResponse, { onExcessProperty: "error" });
/** The selected guest's Owner authority is checked natively; correlate its read here. */
export function isWorkjetJourFixeReadReceiptForRequest(request: unknown, response: unknown): boolean {
 try {
  const intent = decodeReadRequest(request); const result = decodeReadResponse(response);
  if (result.commandId !== intent.commandId || result.projectId !== intent.projectId) return false;
  if (intent.meetingId !== undefined && result.meeting?.id !== intent.meetingId) return false;
  const meeting = result.meeting;
  if (meeting === null) return true;
  if (!Number.isFinite(new Date(meeting.scheduled_at_ms).getTime())) return false;
  new Intl.DateTimeFormat("en", { timeZone: meeting.timezone });
  return [...meeting.slides, ...meeting.comments, ...meeting.transcript, ...(meeting.todos ? [meeting.todos] : [])]
   .every((item) => item.meeting_id === meeting.id);
 } catch { return false; }
}

