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

/** A tick is consumed even when busy; only an admitted round advances the control watermark. */
export const SupervisorTickState = Schema.Struct({
  lastTickAt: IsoDateTime,
  lastControlAt: Schema.NullOr(IsoDateTime),
  outcome: Schema.Literals(["started", "skipped-busy"]),
});
export type SupervisorTickState = typeof SupervisorTickState.Type;

export function supervisorTickDueAt(
  createdAt: string,
  configuration: SupervisorTickConfiguration | undefined,
  state: SupervisorTickState | undefined,
): number | null {
  const config = configuration ?? DEFAULT_SUPERVISOR_TICK_CONFIGURATION;
  if (!config.enabled) return null;
  return Date.parse(state?.lastTickAt ?? createdAt) + config.intervalMinutes * 60_000;
}
