import { useCallback, useMemo } from "react";
import { ProjectId } from "@workjet/contracts";
import type { PromptedProjectKpis } from "../projectKpis";
import { useCtoxClient, useCtoxQuery } from "./hooks";
import { WORKJET_PROJECT_KPIS, type WorkjetProjectKpiDocument } from "./workjetCollections";

/** One local subscription replaces the gallery's serial network reads and retry timers. */
export function useWorkjetProjectKpis(instanceId: string | null, projectIds: string) {
  const api = useCtoxClient(instanceId);
  const ids = useMemo(() => (projectIds === "" ? [] : projectIds.split("\n")), [projectIds]);
  const query = useMemo(() => ({ selector: { project_id: { $in: ids } } }), [ids]);
  const rows = useCtoxQuery<WorkjetProjectKpiDocument>(instanceId, WORKJET_PROJECT_KPIS, query);
  const records = useMemo(
    () =>
      Object.fromEntries(
        rows
          .filter((row) => row.id === row.project_id && ids.includes(row.project_id))
          .map((row) => [
            row.project_id,
            { project_id: row.project_id, revision: row.revision, items: row.items },
          ]),
      ),
    [rows, ids],
  );
  // Preserve the callback contract consumed by KPI configuration and Workjet UI/UX.
  const readKpis = useCallback(
    async (projectId: string): Promise<PromptedProjectKpis | null> => {
      if (api === null || !ids.includes(projectId)) return null;
      return (
        records[projectId] ?? { project_id: ProjectId.make(projectId), revision: 0, items: [] }
      );
    },
    [api, ids, records],
  );
  return { records, readKpis, available: api !== null };
}
