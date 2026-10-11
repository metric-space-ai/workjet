import type { ProjectId, WorkjetThreadConfig } from "@workjet/contracts";
import { UsageDay } from "@workjet/contracts";
import { projectTokenCycle, projectTokenTotal } from "@workjet/shared/projectTokenBudget";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { UsageService } from "./UsageService.ts";

/** Current canonical usage is supplied at turn admission; notices alone can become stale. */
export const currentProjectTokenBudgetContext = Effect.fn("currentProjectTokenBudgetContext")(
  function* (projectId: ProjectId, config?: WorkjetThreadConfig) {
    if (config && (config.schemaVersion !== 2 || config.team?.role !== "supervisor")) return null;
    const query = yield* ProjectionSnapshotQuery;
    const usage = yield* Effect.serviceOption(UsageService);
    const model = yield* query.getCommandReadModel();
    const bound = model.threads.find(
      (thread) =>
        thread.workjetConfig.schemaVersion === 2 &&
        thread.workjetConfig.team?.role === "supervisor" &&
        thread.workjetConfig.ctoxProject?.nativeProjectId === projectId,
    );
    const project = model.projects.find(
      (project) => project.id === projectId || project.id === bound?.projectId,
    );
    if (!project) return null;
    const budget = project.overview?.tokenBudget;
    const now = yield* Clock.currentTimeMillis;
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
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const tokens = summary?.buckets.reduce(
      (sum, bucket) => sum + projectTokenTotal(bucket.totals),
      0,
    );
    const missing =
      project.ctoxRegistration != null ||
      !summary ||
      summary.projectThreads === undefined ||
      summary.projectThreads.some((thread) => thread.status === "unknown");
    return `Token budget: ${tokens === undefined ? "unknown" : (tokens / 1e9).toFixed(3) + "B"}/${budget?.limitBillions == null ? "unlimited" : budget.limitBillions + "B"}${missing ? " (usage unknown/incomplete)" : ""}; meeting/cycle ends ${cycle.end}. Reserve tokens for deck, report and decisions; no automatic stop.`;
  },
);
