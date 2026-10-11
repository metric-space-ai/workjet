import { CommandId, MessageId, UsageDay } from "@workjet/contracts";
import { projectTokenCycle, projectTokenTotal, reachedTokenBudgetThresholds, tokenBudgetNotice } from "@workjet/shared/projectTokenBudget";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { UsageService } from "./UsageService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";

/** Stable command receipts are the once-per-cycle marker, atomic with the system message. */
export const budgetNoticeCommandId = (projectId: string, cycleStart: string, threshold: number) =>
  CommandId.make(`token-budget:${projectId}:${cycleStart}:${threshold}`);

export class ProjectTokenBudgetMonitor extends Context.Service<ProjectTokenBudgetMonitor, {
  readonly runCycle: Effect.Effect<void>;
}>()("workjet/usage/ProjectTokenBudgetMonitor") {}

export const make = Effect.fn("ProjectTokenBudgetMonitor.make")(function* (currentTime: Effect.Effect<number> = Clock.currentTimeMillis) {
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const usage = yield* UsageService;
  const mutex = yield* Semaphore.make(1);
  const runCycle = mutex.withPermit(Effect.gen(function* () {
    const now = yield* currentTime;
    const model = yield* query.getCommandReadModel();
    for (const project of model.projects) {
      const budget = project.overview?.tokenBudget;
      if (project.deletedAt !== null || budget?.limitBillions == null) continue;
      const supervisors = model.threads.filter(t => t.projectId === project.id && t.deletedAt === null && t.archivedAt === null && t.workjetConfig.schemaVersion === 2 && t.workjetConfig.team?.role === "supervisor");
      if (supervisors.length !== 1) continue;
      const cycle = projectTokenCycle(now, budget.jourFixe);
      const summary = yield* usage.readSummary({
        projectId: project.id, sinceDay: UsageDay.make(cycle.start.slice(0,10)),
        untilDay: UsageDay.make(cycle.end.slice(0,10)), timeZone: cycle.timeZone,
        sinceTime: cycle.start, untilTime: cycle.end,
      }).pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (!summary) continue;
      const tokens = summary.buckets.reduce((sum, bucket) => sum + projectTokenTotal(bucket.totals), 0);
      for (const threshold of reachedTokenBudgetThresholds(tokens, budget.limitBillions)) {
        const id = budgetNoticeCommandId(project.id, cycle.start, threshold);
        yield* engine.dispatch({
          type: "thread.message.system.add", commandId: id,
          threadId: supervisors[0]!.id, messageId: MessageId.make(id),
          text: tokenBudgetNotice(tokens, budget.limitBillions, threshold, cycle.end, now),
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        }).pipe(Effect.catchCause(() => Effect.void));
      }
    }
  })).pipe(Effect.catchCause(() => Effect.void));
  return ProjectTokenBudgetMonitor.of({ runCycle });
});
export const layer = Layer.effect(ProjectTokenBudgetMonitor, Effect.gen(function* () {
  const monitor = yield* make();
  yield* forkParked(monitor.runCycle.pipe(Effect.repeat(Schedule.spaced("1 minute"))));
  return monitor;
}));
