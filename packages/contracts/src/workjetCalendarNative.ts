import * as Schema from "effect/Schema";
import { CommandId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkjetCalendarAccounts, WorkjetCalendarEvents } from "./workjetCalendar.ts";
const range = {
  accountId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  startMs: Schema.Int.check(
    Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  endMs: Schema.Int.check(
    Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  ),
};
const ordered = Schema.makeFilter(
  (value: { startMs: number; endMs: number }) =>
    (value.endMs > value.startMs && value.endMs - value.startMs <= 400 * 86_400_000) ||
    "Calendar range must be ordered and at most 400 days",
);
export const WorkjetCalendarNativeRequests = [
  Schema.Struct({ action: Schema.Literal("project.calendar.accounts.read"), commandId: CommandId }),
  Schema.Struct({
    action: Schema.Literal("project.calendar.events.read"),
    commandId: CommandId,
    ...range,
  }).check(ordered),
] as const;
export const WorkjetCalendarNativeResponses = [
  Schema.Struct({
    action: Schema.Literal("project.calendar.accounts.read"),
    commandId: CommandId,
    calendar: WorkjetCalendarAccounts,
  }).check(
    Schema.makeFilter(
      (response) =>
        (new Set(response.calendar.accounts.map((a) => a.id)).size ===
          response.calendar.accounts.length &&
          new Set(response.calendar.accounts.map((a) => a.calendar_id)).size ===
            response.calendar.accounts.length) ||
        "Duplicate calendar accounts",
    ),
  ),
  Schema.Struct({
    action: Schema.Literal("project.calendar.events.read"),
    commandId: CommandId,
    ...range,
    calendar: WorkjetCalendarEvents,
  }).check(
    ordered,
    Schema.makeFilter(
      (response) =>
        (response.calendar.events.every(
          (event) => event.kind === "synced" && event.account_id === response.accountId,
        ) &&
          new Set(response.calendar.events.map((event) => event.id)).size ===
            response.calendar.events.length) ||
        "Calendar events belong to another account",
    ),
  ),
] as const;
export type WorkjetCalendarNativeRequest = (typeof WorkjetCalendarNativeRequests)[number]["Type"];
export type WorkjetCalendarNativeResponse = (typeof WorkjetCalendarNativeResponses)[number]["Type"];
export function isWorkjetCalendarReceiptForRequest(
  request: { readonly action: string },
  response: { readonly action: string },
): boolean {
  if (
    request.action !== "project.calendar.accounts.read" &&
    request.action !== "project.calendar.events.read"
  )
    return true;
  if (response.action !== request.action) return false;
  const read = request as WorkjetCalendarNativeRequest;
  const receipt = response as WorkjetCalendarNativeResponse;
  return (
    read.commandId === receipt.commandId &&
    (read.action !== "project.calendar.events.read" ||
      (receipt.action === read.action &&
        read.accountId === receipt.accountId &&
        read.startMs === receipt.startMs &&
        read.endMs === receipt.endMs))
  );
}
