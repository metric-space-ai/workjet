import { useCallback, useEffect, useState } from "react";
import { ProjectId, type WorkjetJourFixeMeeting } from "@workjet/contracts";
import { useActiveWorkjetScope, readActiveWorkjetScope } from "../activeWorkjetScope";
import { JourFixeNativeSession } from "../lib/jourFixeNative";
import { prefetchJourFixeMeeting } from "../lib/jourFixePrefetch";
import { readWorkjetProjectKpis } from "../workjetProjectControl";

import type { PromptedProjectKpis } from "../projectKpis";

export function useProjectOverviewSources(instanceId: string | null, projectId: string) {
  const scope = useActiveWorkjetScope();
  const [reloadCount, setReloadCount] = useState(0);
  const key = JSON.stringify([instanceId, projectId, scope.selectionRevision, reloadCount]);
  const reload = useCallback(() => setReloadCount((value) => value + 1), []);
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
    let confirmed = false;
    void session.readCached().then((cached) => {
      if (!confirmed && cached?.meeting && current())
        setState((value) => ({ ...value, meeting: cached.meeting ?? null }));
    });
    void session.read().then(
      (result) => {
        confirmed = true;
        if (result.meeting) void prefetchJourFixeMeeting(instanceId, result.meeting);
        if (current()) setState((value) => ({ ...value, meeting: result.meeting ?? null }));
      },
      () => {
        if (current()) setState((value) => ({ ...value, failed: true }));
      },
    );
    void readWorkjetProjectKpis(instanceId, ProjectId.make(projectId)).then(
      (result) => {
        if (!current()) return;
        if (
          result._tag === "completed" &&
          result.response.action === "project.kpis.read" &&
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
  return state.key === key
    ? { ...state, reload }
    : { key, meeting: null, kpis: null, failed: false, reload };
}
