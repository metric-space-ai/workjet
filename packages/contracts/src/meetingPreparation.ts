import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkjetHarness, WorkjetWorkerProfileId } from "./workjet.ts";
import type { CtoxWorkjetJourFixe } from "./ctox.ts";

export const MeetingPreparationConfiguration = Schema.Struct({
  enabled: Schema.Boolean,
  harness: WorkjetHarness,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  leadMinutes: Schema.Array(PositiveInt.check(Schema.isLessThanOrEqualTo(10080))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4),
    Schema.makeFilter(
      (values: readonly number[]) =>
        new Set(values).size === values.length || "Preparation times must be distinct.",
    ),
  ),
  workerProfileId: Schema.optionalKey(WorkjetWorkerProfileId),
});
export type MeetingPreparationConfiguration = typeof MeetingPreparationConfiguration.Type;

export const DEFAULT_MEETING_PREPARATION_CONFIGURATION: MeetingPreparationConfiguration = {
  enabled: true,
  harness: "claude-code",
  model: "grok-4.7",
  leadMinutes: [1440, 120],
};

export const oneShotHarnessUnavailableReason = (harness: WorkjetHarness): string | null =>
  harness === "claude-code" || harness === "codex-cli"
    ? null
    : "Für diesen Harness fehlt die Worktree-Begrenzung für One-Shots.";

export function regularMeetingAt(
  meeting: typeof CtoxWorkjetJourFixe.Type,
  now: number,
  direction: "next" | "previous" = "next",
): number | null {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: meeting.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const minute = Math.floor(now / 60000) * 60000;
  for (let offset = 0; offset <= 10200; offset++) {
    const candidate = minute + (direction === "next" ? offset : -offset) * 60000;
    if (direction === "next" && candidate <= now) continue;
    const parts = formatter.formatToParts(candidate);
    const part = (kind: string) => parts.find((value) => value.type === kind)?.value;
    if (
      weekdays[meeting.weekday - 1] === part("weekday") &&
      meeting.time === part("hour") + ":" + part("minute")
    )
      return candidate;
  }
  return null;
}

/** Windows are half-open: an expired earlier window is replaced by the closer one. */
export function meetingPreparationWindow(
  meeting: typeof CtoxWorkjetJourFixe.Type | null | undefined,
  configuration: MeetingPreparationConfiguration | undefined,
  now: number,
): { meetingAt: string; leadMinutes: number; previousMeetingAt: string } | null {
  const config = configuration ?? DEFAULT_MEETING_PREPARATION_CONFIGURATION;
  if (!meeting || !config.enabled) return null;
  const next = regularMeetingAt(meeting, now);
  if (next === null) return null;
  const remaining = (next - now) / 60000;
  const lead = [...config.leadMinutes].sort((a, b) => a - b).find((value) => remaining <= value);
  if (lead === undefined) return null;
  const previous = regularMeetingAt(meeting, next - 1, "previous");
  if (previous === null) return null;
  return {
    meetingAt: DateTime.formatIso(DateTime.makeUnsafe(next)),
    leadMinutes: lead,
    previousMeetingAt: DateTime.formatIso(DateTime.makeUnsafe(previous)),
  };
}
