import { useCallback, useMemo } from "react";
import { WorkjetJourFixeMeeting } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { useActiveWorkjetScope } from "../activeWorkjetScope";
import { useCtoxDoc, useCtoxQuery } from "../ctox/hooks";
import { useCtoxProjectFeed } from "../ctox/workjetLiveData";
import { WORKJET_PROJECT_KPIS, type WorkjetProjectKpiDocument } from "../ctox/workjetCollections";
import type { PromptedProjectKpis } from "../projectKpis";

const decodeMeeting = Schema.decodeUnknownSync(WorkjetJourFixeMeeting);
export function useProjectOverviewSources(instanceId: string | null, projectId: string) {
  const scope = useActiveWorkjetScope();
  const localKpis = useCtoxDoc<WorkjetProjectKpiDocument>(
    instanceId,
    WORKJET_PROJECT_KPIS,
    projectId,
  );
  const kpis: PromptedProjectKpis | null =
    localKpis?.project_id === projectId && localKpis.id === projectId ? localKpis : null;
  const feedPosts = useCtoxProjectFeed(instanceId, projectId);
  const meetings = useCtoxQuery<WorkjetJourFixeMeeting>(instanceId, "workjet_jour_fixe_meetings", {
    selector: { project_id: projectId, is_current: true, is_deleted: { $ne: true } },
  });
  const local = useMemo(() => {
    try {
      if (meetings.length > 1) return { meeting: null, failed: true };
      const meeting = meetings[0] ? decodeMeeting(meetings[0]) : null;
      return { meeting, failed: false };
    } catch {
      return { meeting: null, failed: true };
    }
  }, [meetings]);
  // The local live view is already current; no remote refresh/retry or duplicate cache exists.
  const reload = useCallback(() => undefined, []);
  return {
    key: JSON.stringify([instanceId, projectId, scope.selectionRevision]),
    ...local,
    kpis,
    feedPosts,
    reload,
    failureText: null,
  };
}
