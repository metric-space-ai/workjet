import type { PromptedProjectKpis } from "./projectKpis";

export interface ProjectKpiProjection {
  readonly instanceId: string | null;
  readonly records: Readonly<Record<string, PromptedProjectKpis>>;
}

export function mergeProjectKpiRead(
  previous: ProjectKpiProjection,
  instanceId: string,
  projectId: string,
  kpis: PromptedProjectKpis,
): ProjectKpiProjection {
  if (kpis.project_id !== projectId) return previous;
  const records = previous.instanceId === instanceId ? previous.records : {};
  const current = records[projectId];
  if (current && current.revision > kpis.revision) return previous;
  return { instanceId, records: { ...records, [projectId]: kpis } };
}
