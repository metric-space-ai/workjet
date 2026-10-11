import { useEffect } from "react";
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import type { ProjectOverviewPr } from "../projectOverviewModel";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironmentQuery } from "../state/query";
import { resolveThreadPr } from "./ThreadStatusIndicators";
export function ProjectOverviewPullRequest(props: {
  readonly thread: EnvironmentThreadShell;
  readonly projectCwd: string | null;
  readonly onRead: (key: string, pr: ProjectOverviewPr | null) => void;
}) {
  const cwd = props.thread.worktreePath ?? props.projectCwd;
  const query = useEnvironmentQuery(
    cwd
      ? vcsEnvironment.status({ environmentId: props.thread.environmentId, input: { cwd } })
      : null,
  );
  const pr = resolveThreadPr({ threadBranch: props.thread.branch, gitStatus: query.data });
  const key = props.thread.environmentId + ":" + props.thread.id;
  const onRead = props.onRead;
  useEffect(() => {
    onRead(key, pr);
  }, [key, onRead, pr]);
  return null;
}
