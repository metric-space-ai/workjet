import * as Schema from "effect/Schema";
import type { WorkjetSupervisorTurn } from "./workjetSupervisor.ts";

/** Mirrors CTOX's shared ctox.workjet.supervisor_execution.v1 fixture. */
const safeText = (maximum: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximum),
    Schema.makeFilter(
      (value) =>
        (value.trim() === value && !/\p{Cc}/u.test(value)) ||
        "Use an unpadded native identity without control characters.",
    ),
  );
const safeInteger = (minimum: number) =>
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(minimum),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  );
export const WorkjetSupervisorEventCursor = Schema.Struct({
  after_sequence: safeInteger(1),
  after_event_id: safeText(128),
});
export type WorkjetSupervisorEventCursor = typeof WorkjetSupervisorEventCursor.Type;

export const WorkjetSupervisorExecutionPageRequest = Schema.Struct({
  attempt_id: Schema.optionalKey(safeText(128)),
  cursor: Schema.optionalKey(WorkjetSupervisorEventCursor),
  limit: Schema.optionalKey(safeInteger(1).check(Schema.isLessThanOrEqualTo(50))),
});
export type WorkjetSupervisorExecutionPageRequest =
  typeof WorkjetSupervisorExecutionPageRequest.Type;

export const WorkjetSupervisorAttemptRef = Schema.Struct({
  attempt_id: safeText(128),
  run_id: Schema.optionalKey(safeText(128)),
  attempt_index: Schema.optionalKey(safeInteger(0)),
  status: Schema.optionalKey(safeText(64)),
  started_at_ms: Schema.optionalKey(safeInteger(0)),
  finished_at_ms: Schema.optionalKey(safeInteger(0)),
});
export const WorkjetSupervisorExecutionEvent = Schema.Struct({
  id: safeText(128),
  sequence: safeInteger(1),
  kind: safeText(64),
  title: Schema.String.check(Schema.isMaxLength(256)),
  created_at_ms: safeInteger(0),
  tool_name: Schema.optionalKey(safeText(128)),
  call_id: Schema.optionalKey(safeText(128)),
  success: Schema.optionalKey(Schema.Boolean),
});
export const WorkjetSupervisorExecutionPage = Schema.Struct({
  command_id: safeText(256),
  task_id: safeText(256),
  attempt: Schema.optionalKey(WorkjetSupervisorAttemptRef),
  events: Schema.Array(WorkjetSupervisorExecutionEvent).check(Schema.isMaxLength(50)),
  next_cursor: Schema.optionalKey(WorkjetSupervisorEventCursor),
  has_more: Schema.Boolean,
}).check(
  Schema.makeFilter((page) => {
    if (page.events.length === 0)
      return !page.has_more || "An empty event page cannot have more events.";
    if (!page.attempt) return "Native events require their actual attempt.";
    const ids = new Set<string>();
    let previous = 0;
    for (const event of page.events) {
      if (event.sequence <= previous || ids.has(event.id))
        return "Native events must have unique IDs and increasing sequences.";
      previous = event.sequence;
      ids.add(event.id);
    }
    const last = page.events.at(-1)!;
    return (
      (page.next_cursor?.after_sequence === last.sequence &&
        page.next_cursor.after_event_id === last.id) ||
      "The native cursor must anchor the last event."
    );
  }),
);
export type WorkjetSupervisorExecutionPage = typeof WorkjetSupervisorExecutionPage.Type;

/** Keep the request's attempt fixed while paging; the task counter is a different fact. */
export function isWorkjetSupervisorExecutionPageForRequest(
  request: WorkjetSupervisorExecutionPageRequest,
  turn: WorkjetSupervisorTurn,
  page: WorkjetSupervisorExecutionPage,
): boolean {
  if (
    page.command_id !== turn.commandId ||
    page.task_id !== turn.taskId ||
    page.events.length > (request.limit ?? 25) ||
    (request.attempt_id !== undefined && request.attempt_id !== page.attempt?.attempt_id)
  )
    return false;
  if (request.cursor) {
    if (
      !request.attempt_id ||
      page.events.some(
        (event) =>
          event.sequence <= request.cursor!.after_sequence ||
          event.id === request.cursor!.after_event_id,
      )
    )
      return false;
    if (
      page.events.length === 0 &&
      (page.next_cursor?.after_sequence !== request.cursor.after_sequence ||
        page.next_cursor.after_event_id !== request.cursor.after_event_id)
    )
      return false;
  } else if (page.events.length === 0 && page.next_cursor !== undefined) return false;
  return true;
}

/** Produces one bounded next watch, never an automatic loop or a new submit. */
export function nextWorkjetSupervisorExecutionPageRequest(
  page: WorkjetSupervisorExecutionPage,
): WorkjetSupervisorExecutionPageRequest {
  return {
    ...(page.attempt ? { attempt_id: page.attempt.attempt_id } : {}),
    ...(page.next_cursor ? { cursor: page.next_cursor } : {}),
    limit: 25,
  };
}
