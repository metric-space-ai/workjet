import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, WorkjetComputer } from "@t3tools/contracts";

import {
  findEnvironmentProjectByPath,
  workjetWorkingCopyMatchesDraftSession,
} from "./availableProjects";
import type { WorkjetProjectRegistrySnapshot } from "./workjetProjectRegistry";

export interface DraftCtoxSessionTarget {
  readonly instanceId: string;
  readonly ctoxProjectId: ProjectId;
  readonly workingCopyId: string;
}

export function resolveDraftCtoxSessionTarget(input: {
  readonly draft: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly presentationInstanceId: string | null;
  readonly registry: WorkjetProjectRegistrySnapshot;
  readonly computers: readonly WorkjetComputer[];
  readonly localProjects: readonly EnvironmentProject[];
}): DraftCtoxSessionTarget | null {
  const { draft, presentationInstanceId, registry } = input;
  if (
    draft.worktreePath === null ||
    presentationInstanceId === null ||
    registry.phase !== "ready" ||
    registry.presentationInstanceId !== presentationInstanceId
  ) {
    return null;
  }

  const serverProject = findEnvironmentProjectByPath({
    projects: input.localProjects,
    environmentId: draft.environmentId,
    path: draft.worktreePath,
  });
  if (serverProject?.id !== draft.projectId) return null;

  for (const project of registry.projects) {
    if (
      !workjetWorkingCopyMatchesDraftSession({
        project,
        computers: input.computers,
        draftSession: draft,
      })
    ) {
      continue;
    }
    const workingCopy = project.workingCopies.find((candidate) =>
      workjetWorkingCopyMatchesDraftSession({
        project: { ...project, workingCopies: [candidate] },
        computers: input.computers,
        draftSession: draft,
      }),
    );
    if (workingCopy !== undefined) {
      return {
        instanceId: presentationInstanceId,
        ctoxProjectId: project.id,
        workingCopyId: workingCopy.id,
      };
    }
  }

  return null;
}
