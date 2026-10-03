import {
  type CtoxWorkjetProjectProjection,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@workjet/contracts";
import { normalizeProjectPathForComparison } from "@workjet/shared/path";

import { workjetLogicalProjectId } from "../../workjetProjectCreation";

export interface SessionImportProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export type SessionImportDestination =
  | { readonly kind: "existing"; readonly project: SessionImportProject }
  | { readonly kind: "new"; readonly title: string; readonly workspaceRoot: string };

export interface SessionImportProjectPort {
  readonly isActive: () => boolean;
  readonly listLogicalProjects: () => Promise<readonly CtoxWorkjetProjectProjection[]>;
  readonly createLocalProject: (project: SessionImportProject) => Promise<void>;
  readonly confirmLogicalProject: (project: SessionImportProject) => Promise<void>;
}

/** Confirm the same project in Code and the active CTOX instance before copying history. */
export async function prepareSessionImportProject(input: {
  readonly presentationInstanceId: string | null;
  readonly environmentId: EnvironmentId;
  readonly destination: SessionImportDestination;
  readonly localProjects: readonly OrchestrationProjectShell[];
  readonly port: SessionImportProjectPort;
}): Promise<SessionImportProject> {
  const assertActive = () => {
    if (!input.port.isActive())
      throw new Error("The active instance or computer changed. Reopen the importer.");
  };
  assertActive();
  const logical =
    input.presentationInstanceId === null ? [] : await input.port.listLogicalProjects();
  assertActive();
  const destination = input.destination;
  let project: SessionImportProject;
  if (destination.kind === "existing") {
    const confirmed = logical.find(({ id }) => id === destination.project.id);
    if (input.presentationInstanceId !== null && !confirmed) {
      throw new Error("The destination project is no longer available in this CTOX instance.");
    }
    project = { ...destination.project, title: confirmed?.title ?? destination.project.title };
  } else {
    const title = destination.title.trim();
    const workspaceRoot = destination.workspaceRoot.trim();
    if (!title || !workspaceRoot)
      throw new Error("Enter a project name and its folder on this computer.");
    const id = await workjetLogicalProjectId(
      input.presentationInstanceId ?? input.environmentId,
      workspaceRoot,
    );
    assertActive();
    const existing = input.localProjects.find(
      (candidate) =>
        normalizeProjectPathForComparison(candidate.workspaceRoot) ===
        normalizeProjectPathForComparison(workspaceRoot),
    );
    if (existing && existing.id !== id)
      throw new Error(
        `This folder already belongs to ${existing.title}. Choose that project instead.`,
      );
    project = {
      id,
      title: existing?.title ?? title,
      workspaceRoot,
    };
  }
  if (!project.workspaceRoot.trim())
    throw new Error("Choose this project's folder on the source computer.");
  const local = input.localProjects.find(({ id }) => id === project.id);
  if (
    local &&
    normalizeProjectPathForComparison(local.workspaceRoot) !==
      normalizeProjectPathForComparison(project.workspaceRoot)
  ) {
    throw new Error("This project's Code folder changed. Refresh the destination projects.");
  }
  assertActive();
  if (!local) await input.port.createLocalProject(project);
  assertActive();
  if (input.presentationInstanceId !== null) await input.port.confirmLogicalProject(project);
  assertActive();
  return project;
}
