import { useEffect, useMemo, useState, useRef } from "react";
import { UsageDay } from "@workjet/contracts";
import { projectTokenCycle } from "@workjet/shared/projectTokenBudget";
import { useUsage } from "../state/usage";
import type { GalleryProject } from "../projectOverview";
import { ProjectTokenBudgetSummary, type ProjectTokenBudgetView } from "./ProjectTokenBudgetSummary";

export function ProjectTokenBudget({ project }: { readonly project: GalleryProject }) {
  const [now, setNow] = useState(Date.now);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => { const timer = window.setInterval(() => { setNow(Date.now()); refreshRef.current(); }, 60_000); return () => window.clearInterval(timer); }, []);
  const budget = project.local?.overview?.tokenBudget;
  const cycle = useMemo(() => projectTokenCycle(now, project.configuration?.jourFixe ?? budget?.jourFixe), [now, project.configuration?.jourFixe, budget?.jourFixe]);
  const usage = useUsage({
    projectId: project.local?.id ?? project.id,
    sinceDay: UsageDay.make(cycle.start.slice(0,10)), untilDay: UsageDay.make(cycle.end.slice(0,10)),
    timeZone: cycle.timeZone, sinceTime: cycle.start, untilTime: cycle.end,
  });
  refreshRef.current = usage.refresh;
  const unknown = usage.environments.flatMap(environment =>
    !environment.summary || environment.error ? [`${environment.label}: Usage nicht verfügbar`]
    : environment.summary.projectThreads === undefined ? [`${environment.label}: Projektzuordnung unbekannt`]
    : environment.summary.projectThreads.filter(t => t.status === "unknown").map(t => `${t.role} · ${t.title}`),
  );
  if (project.local === null) unknown.push("Projekt ist noch nicht lokal gebunden");
  if (project.native) unknown.push("Native Threads: Usage-Zuordnung noch unvollständig");
  const measured = usage.environments.some(e => (e.summary?.buckets.length ?? 0) > 0) || (unknown.length === 0 && usage.environments.some(e => e.summary?.projectThreads !== undefined));
  if (usage.merged.duplicateSources.length) unknown.push("Doppelte Transcript-Quellen: Projektzuordnung möglicherweise unvollständig");
  const threads = (usage.merged.projectThreads ?? []).map(thread => {
    const metadata = usage.environments.flatMap(environment => environment.summary?.projectThreads ?? []).find(candidate => candidate.projectId === thread.projectId && candidate.threadId === thread.threadId);
    return { title: metadata?.title ?? thread.threadId, role: thread.role, tokens: thread.totalTokens };
  });
  const view: ProjectTokenBudgetView = {
    totals: measured && !usage.isPending ? usage.merged : null,
    limitBillions: budget?.limitBillions ?? null, cycle,
    unknown, threads,
  };
  return <ProjectTokenBudgetSummary view={view} />;
}
