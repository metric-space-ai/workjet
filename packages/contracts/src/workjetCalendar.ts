import * as Schema from "effect/Schema";
import { WorkjetConnectionId } from "./workjet.ts";
const boundedText = (max: number, min = 0) =>
  Schema.String.check(
    Schema.makeFilter((value) => {
      const length = Array.from(value).length;
      return (length >= min && length <= max) || "Calendar text violates its character bound";
    }),
  );
const text = (max: number) => boundedText(max, 1);
const integer = Schema.Int.check(
  Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);
const unsigned = integer.check(Schema.isGreaterThanOrEqualTo(0));
/** Mirrors ctox.workjet.calendar.v1; fixtures are shared with the native validators. */
export const WorkjetCalendarEvent = Schema.Struct({
  id: text(128),
  calendar_id: text(128),
  kind: Schema.Literals(["local", "project_meeting", "synced", "project_session"]),
  title: text(256),
  start_ms: integer,
  end_ms: integer,
  all_day: Schema.Boolean,
  timezone: text(128),
  revision: unsigned,
  location: Schema.optionalKey(Schema.NullOr(boundedText(512))),
  notes: Schema.optionalKey(Schema.NullOr(boundedText(4096))),
  project_id: Schema.optionalKey(Schema.NullOr(text(256))),
  session_id: Schema.optionalKey(Schema.NullOr(text(256))),
  account_id: Schema.optionalKey(Schema.NullOr(text(256))),
  external_id: Schema.optionalKey(Schema.NullOr(text(256))),
}).check(
  Schema.makeFilter(
    (event) => event.start_ms < event.end_ms || "Calendar end must follow its start",
  ),
);
export type WorkjetCalendarEvent = typeof WorkjetCalendarEvent.Type;
export const WorkjetCalendarTarget = Schema.Struct({
  connectionId: WorkjetConnectionId,
  instanceId: text(256),
});
export type WorkjetCalendarTarget = typeof WorkjetCalendarTarget.Type;
export const WorkjetCalendarAccounts = Schema.Struct({
  ok: Schema.Literal(true),
  truncated: Schema.Boolean,
  accounts: Schema.Array(
    Schema.Struct({
      id: text(256),
      calendar_id: text(128),
      label: text(256),
      supported: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(100)),
});
export type WorkjetCalendarAccounts = typeof WorkjetCalendarAccounts.Type;
export const WorkjetCalendarEventsInput = Schema.Struct({
  target: WorkjetCalendarTarget,
  accountId: text(256),
  startMs: integer,
  endMs: integer,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.endMs > input.startMs && input.endMs - input.startMs <= 400 * 86_400_000) ||
      "Calendar range must be ordered and at most 400 days",
  ),
);
export type WorkjetCalendarEventsInput = typeof WorkjetCalendarEventsInput.Type;
export const WorkjetCalendarEvents = Schema.Struct({
  ok: Schema.Literal(true),
  events: Schema.Array(WorkjetCalendarEvent).check(Schema.isMaxLength(100)),
  truncated: Schema.Boolean,
  synced_at_ms: unsigned,
});
export type WorkjetCalendarEvents = typeof WorkjetCalendarEvents.Type;
export class WorkjetCalendarError extends Schema.TaggedErrorClass<WorkjetCalendarError>()(
  "WorkjetCalendarError",
  {
    reason: Schema.Literals(["connection-unavailable", "calendar-unavailable"]),
  },
) {}
