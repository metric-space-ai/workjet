import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

export const ProjectBudgetBillions = Schema.Number.check(
  Schema.makeFilter((n) =>
    Number.isFinite(n) && n >= 0.1 && n <= 1_000_000 && Math.abs(n * 10 - Math.round(n * 10)) < 1e-6
      ? true
      : "Enter a positive budget in billions with at most one decimal place.",
  ),
);
export const ProjectBudgetMeeting = Schema.Struct({
  weekday: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 })),
  time: Schema.String.check(Schema.isPattern(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)),
  timezone: Schema.String.check(
    Schema.makeFilter((zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
        return true;
      } catch {
        return "Use a valid IANA timezone.";
      }
    }),
  ),
});
export type ProjectBudgetMeeting = typeof ProjectBudgetMeeting.Type;

/** Server-owned revision; a null limit still reports consumption. */
export const ProjectTokenBudgetSettings = Schema.Struct({
  limitBillions: Schema.NullOr(ProjectBudgetBillions),
  revision: NonNegativeInt,
  jourFixe: Schema.NullOr(ProjectBudgetMeeting),
});
export type ProjectTokenBudgetSettings = typeof ProjectTokenBudgetSettings.Type;
