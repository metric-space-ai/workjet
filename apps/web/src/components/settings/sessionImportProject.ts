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
  readonly attachLocalProjectFolder: (
    project: SessionImportProject,
  ) => Promise<SessionImportProject>;
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
      throw new Error("Instanz oder Rechner gewechselt. Import neu öffnen.");
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
      throw new Error("Zielprojekt in der Instanz nicht mehr verfügbar.");
    }
    project = { ...destination.project, title: confirmed?.title ?? destination.project.title };
  } else {
    const title = destination.title.trim();
    const workspaceRoot = destination.workspaceRoot.trim();
    if (!title || !workspaceRoot) throw new Error("Projektname und Ordner fehlen.");
    const id = await workjetLogicalProjectId(
      input.presentationInstanceId ?? input.environmentId,
      workspaceRoot,
    );
    assertActive();
    const existing = input.localProjects.find(
      (candidate) =>
        candidate.workspaceRoot !== null &&
        normalizeProjectPathForComparison(candidate.workspaceRoot) ===
          normalizeProjectPathForComparison(workspaceRoot),
    );
    if (existing && existing.id !== id)
      throw new Error(`Ordner gehört bereits zu ${existing.title}.`);
    project = {
      id,
      title: existing?.title ?? title,
      workspaceRoot,
    };
  }
  if (!project.workspaceRoot.trim()) throw new Error("Projektordner fehlt.");
  const local = input.localProjects.find(({ id }) => id === project.id);
  if (local) {
    if (local.workspaceRoot === null) {
      const attached = await input.port.attachLocalProjectFolder(project);
      assertActive();
      if (
        attached.id !== project.id ||
        normalizeProjectPathForComparison(attached.workspaceRoot) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        throw new Error("Projektordner auf diesem Rechner nicht bestätigt.");
      }
    } else if (
      normalizeProjectPathForComparison(local.workspaceRoot) !==
      normalizeProjectPathForComparison(project.workspaceRoot)
    ) {
      throw new Error("Projektordner geändert. Zielprojekte neu laden.");
    }
  }
  assertActive();
  if (!local) await input.port.createLocalProject(project);
  assertActive();
  if (input.presentationInstanceId !== null) await input.port.confirmLogicalProject(project);
  assertActive();
  return project;
}
