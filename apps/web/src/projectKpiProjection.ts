import type { PromptedProjectKpis } from "./projectKpis";

export async function readGalleryProjectKpis(
  projectIds: readonly string[],
  read: (projectId: string) => Promise<unknown>,
  isActive: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (isActive() && next < projectIds.length) {
      const projectId = projectIds[next++];
      if (projectId === undefined) return;
      try {
        await read(projectId);
      } catch {
        // Keep other cards readable when one project's transport rejects.
        continue;
      }
    }
  };
  await Promise.all([worker(), worker()]);
}

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
