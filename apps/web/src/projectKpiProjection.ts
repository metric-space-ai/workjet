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
  return {
    instanceId,
    records: { ...records, [projectId]: keepLastKnownKpiValues(current, kpis) },
  };
}

/** A later resolving/failed read must not wipe a value the card already showed (#470).
 * The last ready snapshot for the same prompt revision stays visible, marked stale. */
export function keepLastKnownKpiValues(
  current: PromptedProjectKpis | undefined,
  next: PromptedProjectKpis,
): PromptedProjectKpis {
  if (!current || current.revision !== next.revision) return next;
  let changed = false;
  const items = next.items.map((item) => {
    if (item.result.status === "ready" || item.result.status === "stale") return item;
    const previous = current.items.find(
      (candidate) =>
        candidate.prompt.kpi_id === item.prompt.kpi_id &&
        candidate.prompt.revision === item.prompt.revision,
    );
    if (
      !previous?.result.snapshot ||
      (previous.result.status !== "ready" && previous.result.status !== "stale")
    )
      return item;
    changed = true;
    return {
      ...item,
      result: {
        ...previous.result,
        status: "stale" as const,
        ...(item.result.message ? { message: item.result.message } : {}),
      },
    };
  });
  return changed ? { ...next, items } : next;
}
