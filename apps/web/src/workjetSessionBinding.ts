import type { EnvironmentProject } from "@workjet/client-runtime/state/shell";
import {
  normalizeWorkjetThreadConfig,
  type CtoxWorkjetSessionControlResult,
  type BusinessOsInstanceId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type WorkjetComputer,
  type WorkjetThreadConfig,
  type WorkjetThreadConfigV2,
} from "@workjet/contracts";

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

export interface CtoxSessionBindingResult {
  readonly instanceId: string | null;
  readonly result: CtoxWorkjetSessionControlResult | null;
  readonly project?: {
    readonly codeProjectId: ProjectId;
    readonly codeThreadId: ThreadId;
    readonly businessOsInstanceId: BusinessOsInstanceId;
    readonly nativeProjectId: ProjectId;
    readonly workingCopyId: string;
  };
}

export function withCtoxSessionBinding(
  config: WorkjetThreadConfig,
  bindingResult: CtoxSessionBindingResult,
): WorkjetThreadConfigV2 {
  const normalized = normalizeWorkjetThreadConfig(config);
  const result = bindingResult.result;
  if (
    bindingResult.instanceId === null ||
    result?._tag !== "completed" ||
    result.response.action !== "session.create"
  ) {
    return { ...normalized, ctoxSession: null, ctoxProject: undefined };
  }
  const project = bindingResult.project;
  const nativeSession = result.response.session;
  const confirmedProject =
    project !== undefined &&
    nativeSession.projectId === project.nativeProjectId &&
    nativeSession.workingCopyId === project.workingCopyId &&
    nativeSession.threadId === project.codeThreadId
      ? {
          codeProjectId: project.codeProjectId,
          codeThreadId: project.codeThreadId,
          presentationInstanceId: bindingResult.instanceId,
          businessOsInstanceId: project.businessOsInstanceId,
          nativeProjectId: project.nativeProjectId,
          workingCopyId: project.workingCopyId,
          nativeSessionId: nativeSession.id,
        }
      : undefined;
  if (project !== undefined && confirmedProject === undefined) {
    return { ...normalized, ctoxSession: null, ctoxProject: undefined };
  }
  return {
    ...normalized,
    ctoxProject: confirmedProject,
    ctoxSession: {
      instanceId: bindingResult.instanceId,
      sessionId: nativeSession.id,
      fenceEpoch: nativeSession.fenceEpoch,
    },
  };
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

  let match: DraftCtoxSessionTarget | null = null;
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
    for (const workingCopy of project.workingCopies) {
      if (
        !workjetWorkingCopyMatchesDraftSession({
          project: { ...project, workingCopies: [workingCopy] },
          computers: input.computers,
          draftSession: draft,
        })
      ) {
        continue;
      }
      // Two native projects (or two copies) claiming the same physical
      // workspace cannot authorize an implicit project choice.
      if (match !== null) return null;
      match = {
        instanceId: presentationInstanceId,
        ctoxProjectId: project.id,
        workingCopyId: workingCopy.id,
      };
    }
  }

  return match;
}
