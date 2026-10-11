import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DEFAULT_MEETING_PREPARATION_CONFIGURATION as defaults,
  MeetingPreparationConfiguration,
  meetingPreparationWindow,
  oneShotHarnessUnavailableReason,
  regularMeetingAt,
} from "./meetingPreparation.ts";
const meeting = { weekday: 1, time: "13:00", timezone: "Europe/Berlin" };
const at = (time: string) => Date.parse(time);
describe("meeting preparation", () => {
  it("defaults to the confined Claude harness and the requested pool model", () => {
    expect(Schema.decodeUnknownSync(MeetingPreparationConfiguration)(defaults)).toEqual({
      enabled: true,
      harness: "claude-code",
      model: "grok-4.7",
      leadMinutes: [1440, 120],
    });
    expect(oneShotHarnessUnavailableReason("claude-code")).toBeNull();
    expect(oneShotHarnessUnavailableReason("codex-cli")).toBeNull();
    for (const harness of ["grok-cli", "opencode", "pi-code"] as const)
      expect(oneShotHarnessUnavailableReason(harness)).toContain("Worktree");
  });
  it("validates distinct positive times and retains disabled settings", () => {
    const decode = Schema.decodeUnknownSync(MeetingPreparationConfiguration);
    for (const leadMinutes of [[0], [10081], [120, 120], []])
      expect(() => decode({ ...defaults, leadMinutes })).toThrow();
    expect(decode({ ...defaults, enabled: false }).harness).toBe("claude-code");
  });
  it("opens T-24h once its boundary is reached, using the prior meeting as the brief cutoff", () => {
    expect(meetingPreparationWindow(meeting, defaults, at("2026-10-11T10:59:59Z"))).toBeNull();
    expect(meetingPreparationWindow(meeting, defaults, at("2026-10-11T11:00:00Z"))).toEqual({
      meetingAt: "2026-10-12T11:00:00.000Z",
      leadMinutes: 1440,
      previousMeetingAt: "2026-10-05T11:00:00.000Z",
    });
  });
  it("selects only T-2h at the shared boundary and after a missed earlier window", () => {
    expect(
      meetingPreparationWindow(meeting, defaults, at("2026-10-12T09:00:00Z"))?.leadMinutes,
    ).toBe(120);
    expect(
      meetingPreparationWindow(meeting, defaults, at("2026-10-12T10:59:59Z"))?.leadMinutes,
    ).toBe(120);
    expect(meetingPreparationWindow(meeting, defaults, at("2026-10-12T11:00:00Z"))).toBeNull();
  });
  it("keeps the occurrence identity stable across ticks and restarts", () => {
    const first = meetingPreparationWindow(meeting, defaults, at("2026-10-11T17:16:44Z"));
    expect(meetingPreparationWindow(meeting, defaults, at("2026-10-11T17:46:12Z"))).toEqual(first);
  });
  it("honors off, missing meetings and custom times", () => {
    expect(
      meetingPreparationWindow(meeting, { ...defaults, enabled: false }, at("2026-10-11T17:16Z")),
    ).toBeNull();
    expect(meetingPreparationWindow(null, defaults, at("2026-10-11T17:16Z"))).toBeNull();
    expect(
      meetingPreparationWindow(meeting, { ...defaults, leadMinutes: [60] }, at("2026-10-12T10:00Z"))
        ?.leadMinutes,
    ).toBe(60);
  });
  it("uses the configured zone across the autumn DST change", () => {
    expect(regularMeetingAt(meeting, at("2026-10-25T13:00:00Z"))).toBe(at("2026-10-26T12:00:00Z"));
    expect(regularMeetingAt(meeting, at("2026-10-26T11:59:59Z"))).toBe(at("2026-10-26T12:00:00Z"));
  });
});
