import { describe, expect, it } from "vite-plus/test";
import {
  supervisorFirstTickAt,
  supervisorTickDueAt,
  type SupervisorTickState,
} from "./supervisorTick.ts";

const now = Date.parse("2026-10-11T13:00:00.000Z");
describe("initial supervisor tick planning", () => {
  it("spreads initial controls throughout the default interval", () => {
    const due = [0, 0.25, 0.5, 0.75, 0.999999].map((sample) =>
      supervisorFirstTickAt(now, undefined, () => sample),
    );
    expect(due[0]).toBe(now);
    expect(due[1]).toBe(now + 7.5 * 60_000);
    expect(due[3]).toBe(now + 22.5 * 60_000);
    expect(due.every((time) => time !== null && time >= now && time < now + 30 * 60_000)).toBe(true);
    expect(new Set(due).size).toBe(due.length);
  });
  it("honors configured intervals and disabled cadence", () => {
    expect(supervisorFirstTickAt(now, { enabled: true, intervalMinutes: 60 }, () => 0.5)).toBe(now + 30 * 60_000);
    expect(supervisorFirstTickAt(now, { enabled: false, intervalMinutes: 30 })).toBeNull();
  });
  it("restores a saved first due time without sampling again and caps interval reductions", () => {
    const state: SupervisorTickState = {
      firstTickAt: "2026-10-11T13:20:00.000Z",
      lastTickAt: "2026-10-11T13:00:00.000Z",
      lastControlAt: null,
      outcome: "scheduled",
    };
    expect(supervisorTickDueAt("2020-01-01T00:00:00Z", undefined, state)).toBe(now + 20 * 60_000);
    expect(supervisorTickDueAt("2020-01-01T00:00:00Z", { enabled: true, intervalMinutes: 10 }, state)).toBe(now + 10 * 60_000);
    expect(supervisorTickDueAt("2020-01-01T00:00:00Z", { enabled: false, intervalMinutes: 30 }, state)).toBeNull();
  });
});
