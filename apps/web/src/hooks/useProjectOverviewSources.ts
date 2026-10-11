import { useEffect, useState } from "react";
import { ProjectId, type WorkjetJourFixeMeeting } from "@workjet/contracts";
import { useActiveWorkjetScope, readActiveWorkjetScope } from "../activeWorkjetScope";
import { JourFixeNativeSession } from "../lib/jourFixeNative";
import { readWorkjetProjectKpis } from "../workjetProjectControl";
import { newCommandId } from "../lib/utils";
import type { PromptedProjectKpis } from "../projectKpis";

export function useProjectOverviewSources(instanceId: string | null, projectId: string) {
  const scope = useActiveWorkjetScope();
  const key = JSON.stringify([instanceId, projectId, scope.selectionRevision]);
  const [state, setState] = useState<{
    key: string;
    meeting: WorkjetJourFixeMeeting | null;
    kpis: PromptedProjectKpis | null;
    failed: boolean;
  }>({ key, meeting: null, kpis: null, failed: false });
  useEffect(() => {
    let active = true;
    const current = () =>
      active &&
      readActiveWorkjetScope().selectedInstanceId === instanceId &&
      readActiveWorkjetScope().selectionRevision === scope.selectionRevision;
    setState({ key, meeting: null, kpis: null, failed: false });
    if (!instanceId || !current())
      return () => {
        active = false;
      };
    const session = new JourFixeNativeSession(instanceId, ProjectId.make(projectId), current);
    void session.read().then(
      (result) => {
        if (current()) setState((value) => ({ ...value, meeting: result.meeting ?? null }));
      },
      () => {
        if (current()) setState((value) => ({ ...value, failed: true }));
      },
    );
    const commandId = newCommandId();
    void readWorkjetProjectKpis(instanceId, ProjectId.make(projectId), commandId).then(
      (result) => {
        if (!current()) return;
        if (
          result._tag === "completed" &&
          result.response.action === "project.kpis.read" &&
          result.response.commandId === commandId &&
          result.response.projectId === projectId &&
          "kpis" in result.response
        ) {
          const kpis = result.response.kpis;
          setState((value) => ({ ...value, kpis }));
        } else setState((value) => ({ ...value, failed: true }));
      },
      () => {
        if (current()) setState((value) => ({ ...value, failed: true }));
      },
    );
    return () => {
      active = false;
      session.close();
    };
  }, [instanceId, projectId, key, scope.selectionRevision]);
  return state.key === key ? state : { key, meeting: null, kpis: null, failed: false };
}
