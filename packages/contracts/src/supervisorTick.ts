import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt } from "./baseSchemas.ts";

export const SupervisorTickConfiguration = Schema.Struct({
  enabled: Schema.Boolean,
  intervalMinutes: PositiveInt.check(Schema.isLessThanOrEqualTo(10080)),
});
export type SupervisorTickConfiguration = typeof SupervisorTickConfiguration.Type;

export const DEFAULT_SUPERVISOR_TICK_CONFIGURATION: SupervisorTickConfiguration = {
  enabled: true,
  intervalMinutes: 30,
};

/** Initial planning is persisted; only an admitted round advances the control watermark. */
export const SupervisorTickState = Schema.Struct({
  lastTickAt: IsoDateTime,
  lastControlAt: Schema.NullOr(IsoDateTime),
  firstTickAt: Schema.optionalKey(IsoDateTime),
  outcome: Schema.Literals(["scheduled", "started", "skipped-busy"]),
});
export type SupervisorTickState = typeof SupervisorTickState.Type;

export function supervisorFirstTickAt(
  now: number,
  configuration: SupervisorTickConfiguration | undefined,
  random: () => number = Math.random,
): number | null {
  const config = configuration ?? DEFAULT_SUPERVISOR_TICK_CONFIGURATION;
  return config.enabled ? now + Math.floor(random() * config.intervalMinutes * 60_000) : null;
}

export function supervisorTickDueAt(
  createdAt: string,
  configuration: SupervisorTickConfiguration | undefined,
  state: SupervisorTickState | undefined,
): number | null {
  const config = configuration ?? DEFAULT_SUPERVISOR_TICK_CONFIGURATION;
  if (!config.enabled) return null;
  if (state?.outcome === "scheduled" && state.firstTickAt) {
    return Math.min(
      Date.parse(state.firstTickAt),
      Date.parse(state.lastTickAt) + config.intervalMinutes * 60_000,
    );
  }
  return Date.parse(state?.lastTickAt ?? createdAt) + config.intervalMinutes * 60_000;
}
