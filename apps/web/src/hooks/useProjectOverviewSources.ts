import type { CtoxWorkjetProjectFeedPost } from "@workjet/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProjectId, WorkjetJourFixeMeeting } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { useCtoxClient, useCtoxDoc, useCtoxQuery } from "../ctox/hooks";
import { useCtoxProjectFeed } from "../ctox/workjetLiveData";
import { WORKJET_PROJECT_KPIS, type WorkjetProjectKpiDocument } from "../ctox/workjetCollections";
import { useActiveWorkjetScope, readActiveWorkjetScope } from "../activeWorkjetScope";
import { JourFixeNativeSession } from "../lib/jourFixeNative";
import { prefetchJourFixeMeeting } from "../lib/jourFixePrefetch";
import {
  describeWorkjetProjectControlFailure,
  readWorkjetProjectFeed,
  readWorkjetProjectKpis,
  workjetUiLanguage,
} from "../workjetProjectControl";

import type { PromptedProjectKpis } from "../projectKpis";

/**
 * Scheibe C: on a V4 instance (bound kernel client) the overview is a live local view; on V3 the
 * unchanged desktop-port reads below run. Both hooks are always called; the inactive one gets a
 * null instance and stays inert.
 */
export function useProjectOverviewSources(instanceId: string | null, projectId: string) {
  const v4 = useCtoxClient(instanceId) !== null;
  const local = useLocalProjectOverviewSources(v4 ? instanceId : null, projectId);
  const legacy = useLegacyProjectOverviewSources(v4 ? null : instanceId, projectId);
  return v4 ? local : legacy;
}

const decodeMeeting = Schema.decodeUnknownSync(WorkjetJourFixeMeeting);
const noReload = () => undefined;
function useLocalProjectOverviewSources(instanceId: string | null, projectId: string) {
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
  const meeting = useMemo(() => {
    try {
      if (meetings.length > 1) return { meeting: null, failed: true };
      return { meeting: meetings[0] ? decodeMeeting(meetings[0]) : null, failed: false };
    } catch {
      return { meeting: null, failed: true };
    }
  }, [meetings]);
  // The local live view is already current; there is no remote refresh or retry.
  return {
    key: JSON.stringify([instanceId, projectId, scope.selectionRevision]),
    ...meeting,
    kpis,
    failureText: null,
    reload: noReload,
    feedPosts: feedPosts as readonly CtoxWorkjetProjectFeedPost[],
  };
}

function useLegacyProjectOverviewSources(instanceId: string | null, projectId: string) {
  const scope = useActiveWorkjetScope();
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
        } else
          setState((value) => ({
            ...value,
            failed: true,
            failureText: result._tag === "failed" ? overviewFailureText(result) : value.failureText,
          }));
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
  // Supervisor feed posts; `unsupported` or a failure keeps the derived cards (empty list).
  const [feed, setFeed] = useState<{
    key: string;
    posts: readonly CtoxWorkjetProjectFeedPost[];
    supported: boolean | null;
  }>({ key, posts: [], supported: null });
  useEffect(() => {
    if (!instanceId) return;
    let active = true;
    void readWorkjetProjectFeed(instanceId, ProjectId.make(projectId)).then(
      (result) => {
        if (!active) return;
        setFeed({
          key,
          posts: result._tag === "posts" ? result.posts : [],
          supported: result._tag === "posts" ? true : result._tag === "unsupported" ? false : null,
        });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [instanceId, projectId, key]);
  const feedPosts = feed.key === key ? feed.posts : [];
  return state.key === key
    ? { ...state, reload, feedPosts }
    : { key, meeting: null, kpis: null, failed: false, failureText: null, reload, feedPosts };
}

function overviewFailureText(
  failure: Parameters<typeof describeWorkjetProjectControlFailure>[0],
): string {
  const en = workjetUiLanguage() === "en";
  if ("reason" in failure && String(failure.reason).includes("core_outdated"))
    return en
      ? "Core outdated · apply the current CTOX core on the instance"
      : "Core veraltet · aktuellen CTOX-Core auf der Instanz anwenden";
  return `${en ? "Project data not loaded" : "Projektdaten nicht geladen"} · ${describeWorkjetProjectControlFailure(failure)}`;
}
