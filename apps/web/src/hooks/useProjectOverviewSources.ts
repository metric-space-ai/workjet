import { useCallback, useEffect, useState } from "react";
import { ProjectId, type WorkjetJourFixeMeeting } from "@workjet/contracts";
import { useActiveWorkjetScope, readActiveWorkjetScope } from "../activeWorkjetScope";
import { JourFixeNativeSession } from "../lib/jourFixeNative";
import { prefetchJourFixeMeeting } from "../lib/jourFixePrefetch";
import { useCtoxDoc } from "../ctox/hooks";
import { useCtoxProjectFeed } from "../ctox/workjetLiveData";
import { WORKJET_PROJECT_KPIS, type WorkjetProjectKpiDocument } from "../ctox/workjetCollections";

import type { PromptedProjectKpis } from "../projectKpis";

export function useProjectOverviewSources(instanceId: string | null, projectId: string) {
  const scope = useActiveWorkjetScope();
  const localKpis = useCtoxDoc<WorkjetProjectKpiDocument>(
    instanceId,
    WORKJET_PROJECT_KPIS,
    projectId,
  );
  const kpis = localKpis?.project_id === projectId && localKpis.id === projectId ? localKpis : null;
  const feedPosts = useCtoxProjectFeed(instanceId, projectId);
  const [reloadCount, setReloadCount] = useState(0);
  const key = JSON.stringify([instanceId, projectId, scope.selectionRevision, reloadCount]);
  const reload = useCallback(() => setReloadCount((value) => value + 1), []);
  const [state, setState] = useState<{
    key: string;
    meeting: WorkjetJourFixeMeeting | null;
    kpis: PromptedProjectKpis | null;
    failed: boolean;
    /** Why the data is missing; a failed read is not a lost connection (#681). */
    failureText: string | null;
  }>({ key, meeting: null, kpis: null, failed: false, failureText: null });
  useEffect(() => {
    let active = true;
    const current = () =>
      active &&
      readActiveWorkjetScope().selectedInstanceId === instanceId &&
      readActiveWorkjetScope().selectionRevision === scope.selectionRevision;
    setState({ key, meeting: null, kpis: null, failed: false, failureText: null });
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
    return () => {
      active = false;
      session.close();
    };
  }, [instanceId, projectId, key, scope.selectionRevision]);
  return state.key === key
    ? { ...state, kpis, reload, feedPosts }
    : { key, meeting: null, kpis, failed: false, failureText: null, reload, feedPosts };
}
