import { UsageDay, type OrchestrationProject } from "@workjet/contracts";
import { projectTokenCycle, projectTokenTotal } from "@workjet/shared/projectTokenBudget";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { UsageService } from "./UsageService.ts";

/** A bounded view of the same canonical usage consumed by the project overview. */
export const readProjectTokenBudgetStatus = Effect.fn("readProjectTokenBudgetStatus")(function* (
  project: OrchestrationProject,
  now: number,
) {
  const usage = yield* Effect.serviceOption(UsageService);
  const budget = project.overview?.tokenBudget;
  const cycle = projectTokenCycle(now, budget?.jourFixe);
  const summary = Option.isNone(usage)
    ? null
    : yield* usage.value
        .readSummary({
          projectId: project.id,
          sinceDay: UsageDay.make(cycle.start.slice(0, 10)),
          untilDay: UsageDay.make(cycle.end.slice(0, 10)),
          sinceTime: cycle.start,
          untilTime: cycle.end,
          timeZone: cycle.timeZone,
        })
        .pipe(
          Effect.timeout("15 seconds"),
          Effect.catchCause(() => Effect.succeed(null)),
        );
  const consumedTokens =
    summary?.buckets.reduce((sum, bucket) => sum + projectTokenTotal(bucket.totals), 0) ?? null;
  const unknownThreads =
    summary?.projectThreads?.filter((thread) => thread.status === "unknown").length ?? null;
  const limitBillions = budget?.limitBillions ?? null;
  return {
    consumedTokens,
    limitBillions,
    usedPercent:
      consumedTokens === null || limitBillions === null
        ? null
        : (consumedTokens / (limitBillions * 1e9)) * 100,
    cycle,
    usageStatus:
      summary === null
        ? ("unavailable" as const)
        : project.ctoxRegistration != null || unknownThreads === null || unknownThreads > 0
          ? ("incomplete" as const)
          : ("measured" as const),
    unknownThreads,
  };
});
export type ProjectTokenBudgetStatus = Effect.Success<
  ReturnType<typeof readProjectTokenBudgetStatus>
>;
