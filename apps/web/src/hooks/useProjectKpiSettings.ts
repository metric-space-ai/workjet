import { ProjectId } from "@workjet/contracts";
import { useCallback, useEffect, useState } from "react";
import { newCommandId } from "../lib/utils";
import type { PromptedProjectKpis, SaveProjectKpiPrompts } from "../projectKpis";
import { readActiveWorkjetScope } from "../activeWorkjetScope";
import { readWorkjetProjectKpis, saveWorkjetProjectKpis } from "../workjetProjectControl";

/** Liest die drei KPI-Sätze eines nativen Projekts und speichert sie über project.kpis.configure. */
export function useProjectKpiSettings(
  instanceId: string | null,
  projectId: string | undefined,
): {
  readonly kpis: PromptedProjectKpis | undefined;
  readonly loadFailed: boolean;
  readonly save: SaveProjectKpiPrompts | undefined;
} {
  const [kpis, setKpis] = useState<PromptedProjectKpis | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    setKpis(undefined);
    setLoadFailed(false);
    if (instanceId === null || projectId === undefined) return;
    let active = true;
    void readWorkjetProjectKpis(instanceId, ProjectId.make(projectId)).then(
      (result) => {
        if (
          active &&
          result._tag === "completed" &&
          result.response.action === "project.kpis.read" &&
          result.response.projectId === projectId &&
          "kpis" in result.response
        )
          setKpis(result.response.kpis);
        else if (active) setLoadFailed(true);
      },
      () => {
        if (active) setLoadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [instanceId, projectId]);
  const save = useCallback<SaveProjectKpiPrompts>(
    async (prompts, expectedRevision) => {
      if (instanceId === null || projectId === undefined) return false;
      if (readActiveWorkjetScope().selectedInstanceId !== instanceId) return false;
      const saved = await saveWorkjetProjectKpis(instanceId, {
        action: "project.kpis.configure",
        commandId: newCommandId(),
        projectId: ProjectId.make(projectId),
        operationId: newCommandId(),
        expectedRevision,
        prompts: [...prompts],
      });
      if (saved === null) return false;
      setKpis(saved);
      return true;
    },
    [instanceId, projectId],
  );
  return {
    kpis,
    loadFailed,
    save: instanceId !== null && projectId !== undefined ? save : undefined,
  };
}
