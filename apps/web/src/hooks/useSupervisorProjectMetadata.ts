import { useEffect, useRef } from "react";
import type { GalleryProject } from "../projectOverview";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

/** Persist the already identity-bound native meeting metadata for server control rounds. */
export function useSupervisorProjectMetadata(project: GalleryProject) {
  const update = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const attempted = useRef<string | null>(null);
  const local = project.local;
  const native = project.configuration;
  const meeting = native?.jourFixe ?? null;
  const key = local && native ? local.environmentId + ":" + local.id + ":" + JSON.stringify(meeting) + ":" + (native.repoUrl ?? "") : null;
  useEffect(() => {
    if (!local || !native || key === null || attempted.current === key) return;
    if (JSON.stringify(local.overview?.regularMeeting ?? null) === JSON.stringify(meeting) &&
      (local.overview?.repositoryUrl ?? null) === (native.repoUrl ?? null)) return;
    attempted.current = key;
    void update({
      environmentId: local.environmentId,
      input: { projectId: local.id, overview: {
        websiteUrl: null, slots: [null, null, null], ...local.overview,
        regularMeeting: meeting, repositoryUrl: native.repoUrl ?? null,
      } },
    });
  }, [key, local, meeting, native, update]);
}
