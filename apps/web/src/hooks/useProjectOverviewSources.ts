import type { CtoxWorkjetProjectFeedPost } from "@workjet/contracts";
import { useCallback, useEffect, useState } from "react";
import { ProjectId, type WorkjetJourFixeMeeting } from "@workjet/contracts";
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
