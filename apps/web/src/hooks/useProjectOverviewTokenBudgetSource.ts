import { useEffect, useMemo, useRef, useState } from "react";
import { UsageDay } from "@workjet/contracts";
import { projectTokenCycle, projectTokenTotal } from "@workjet/shared/projectTokenBudget";
import type { GalleryProject } from "../projectOverview";
import type { ProjectOverviewTokenBudgetSource } from "../projectOverviewModel";
import { useUsage, type UsageView } from "../state/usage";

/** Preserve #417's known-consumption and completeness rules without exposing its diagnostics. */
export function projectOverviewTokenBudgetSource(
  project: GalleryProject,
  usage: UsageView,
): ProjectOverviewTokenBudgetSource {
  const partial =
    project.local === null ||
    project.native ||
    usage.merged.duplicateSources.length > 0 ||
    usage.environments.some(
      (environment) =>
        environment.summary === null ||
        environment.error !== null ||
        environment.summary.projectThreads === undefined ||
        environment.summary.projectThreads.some((thread) => thread.status === "unknown"),
    );
  const measured =
    usage.environments.some((environment) => (environment.summary?.buckets.length ?? 0) > 0) ||
    (!partial &&
      usage.environments.some((environment) => environment.summary?.projectThreads !== undefined));
  return {
    consumedTokens: measured && !usage.isPending ? projectTokenTotal(usage.merged) : null,
    limitBillions: project.local?.overview?.tokenBudget?.limitBillions ?? null,
    partial,
  };
}

/** Same project/window atom as ProjectTokenBudgetSummary's source; reads are shared. */
export function useProjectOverviewTokenBudgetSource(project: GalleryProject) {
  const [now, setNow] = useState(Date.now);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      refreshRef.current();
    }, 60000);
    return () => window.clearInterval(timer);
  }, []);
  const budget = project.local?.overview?.tokenBudget;
  const cycle = useMemo(
    () =>
      projectTokenCycle(
        now,
        project.configuration?.jourFixe === undefined
          ? budget?.jourFixe
          : project.configuration.jourFixe,
      ),
    [now, project.configuration?.jourFixe, budget?.jourFixe],
  );
  const usage = useUsage({
    projectId: project.local?.id ?? project.id,
    sinceDay: UsageDay.make(cycle.start.slice(0, 10)),
    untilDay: UsageDay.make(cycle.end.slice(0, 10)),
    timeZone: cycle.timeZone,
    sinceTime: cycle.start,
    untilTime: cycle.end,
  });
  refreshRef.current = usage.refresh;
  return projectOverviewTokenBudgetSource(project, usage);
}
