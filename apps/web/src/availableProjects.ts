import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  CtoxWorkjetProjectProjection,
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  WorkjetComputer,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { useActiveWorkjetScope } from "./activeWorkjetScope";
import { useComposerDraftStore } from "./composerDraftStore";
import { usePrimarySettings } from "./hooks/useSettings";
import { useBusinessOsScopedEnvironments, usePrimaryEnvironment } from "./state/environments";
import { useProjects } from "./state/entities";
import { resolveThreadRouteTarget } from "./threadRoutes";
import {
  resolveWorkjetComputer,
  useWorkjetProjectRegistry,
  type WorkjetProjectRegistrySnapshot,
} from "./workjetProjectRegistry";

export type AvailableProject =
  | {
      readonly kind: "local";
      readonly id: ProjectId;
      readonly title: string;
      readonly environmentId: EnvironmentId;
      readonly path: string;
    }
  | {
      readonly kind: "workjet";
      readonly id: ProjectId;
      readonly title: string;
      readonly environmentId: EnvironmentId;
      readonly path: string;
      readonly workingCopyId: string;
    };

export interface AvailableProjectContext {
  readonly availableProjects: readonly AvailableProject[];
  readonly localProjects: readonly EnvironmentProject[];
  readonly resolvedComputer: WorkjetComputer | null;
  readonly workjetProjectRegistry: WorkjetProjectRegistrySnapshot;
  readonly workjetProjects: readonly CtoxWorkjetProjectProjection[];
}

function normalizedProjectPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
}

export function findEnvironmentProjectByPath(input: {
  readonly projects: readonly EnvironmentProject[];
  readonly environmentId: EnvironmentId;
  readonly path: string;
}): EnvironmentProject | undefined {
  const normalizedPath = normalizedProjectPath(input.path);
  return input.projects.find(
    (project) =>
      project.environmentId === input.environmentId &&
      normalizedProjectPath(project.workspaceRoot) === normalizedPath,
  );
}

export function buildAvailableProjects(input: {
  readonly projects: readonly EnvironmentProject[];
  readonly workjetProjects: readonly CtoxWorkjetProjectProjection[];
  readonly computer: WorkjetComputer | null;
  readonly selectedWorkjetProjectId?: string | null;
}): readonly AvailableProject[] {
  const localProjects: AvailableProject[] = input.projects.map((project) => ({
    kind: "local",
    id: project.id,
    title: project.title,
    environmentId: project.environmentId,
    path: project.workspaceRoot,
  }));
  const computer = input.computer;
  if (computer === null) return localProjects;

  const localKeys = new Set(
    localProjects.flatMap((project) => [
      `${project.environmentId}:${project.id}`,
      `${project.environmentId}:${normalizedProjectPath(project.path)}`,
    ]),
  );
  const orderedWorkjetProjects = [...input.workjetProjects].sort((left, right) => {
    if (left.id === input.selectedWorkjetProjectId) return -1;
    if (right.id === input.selectedWorkjetProjectId) return 1;
    return 0;
  });
  const workjetProjects = orderedWorkjetProjects.flatMap((project): AvailableProject[] => {
    const workingCopy = project.workingCopies.find(
      (candidate) => candidate.computerId === computer.id && candidate.status === "active",
    );
    if (workingCopy === undefined) return [];
    if (
      localKeys.has(`${computer.environmentId}:${project.id}`) ||
      localKeys.has(`${computer.environmentId}:${normalizedProjectPath(workingCopy.path)}`)
    ) {
      return [];
    }
    return [
      {
        kind: "workjet",
        id: project.id,
        title: project.title,
        environmentId: computer.environmentId,
        path: workingCopy.path,
        workingCopyId: workingCopy.id,
      },
    ];
  });

  return [...localProjects, ...workjetProjects];
}

interface WorkjetDraftSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

export function workjetWorkingCopyMatchesDraftSession(input: {
  readonly project: CtoxWorkjetProjectProjection;
  readonly computers: readonly WorkjetComputer[];
  readonly draftSession: WorkjetDraftSessionTarget;
}): boolean {
  if (input.draftSession.worktreePath === null) return false;
  const computerIds = new Set<string>(
    input.computers
      .filter((computer) => computer.environmentId === input.draftSession.environmentId)
      .map((computer) => computer.id),
  );
  const draftPath = normalizedProjectPath(input.draftSession.worktreePath);
  return input.project.workingCopies.some(
    (workingCopy) =>
      workingCopy.status === "active" &&
      computerIds.has(workingCopy.computerId) &&
      normalizedProjectPath(workingCopy.path) === draftPath,
  );
}

export function workjetProjectMatchesDraftSession(input: {
  readonly project: CtoxWorkjetProjectProjection;
  readonly computers: readonly WorkjetComputer[];
  readonly draftSession: WorkjetDraftSessionTarget;
}): boolean {
  return (
    input.project.id === input.draftSession.projectId &&
    workjetWorkingCopyMatchesDraftSession(input)
  );
}

export function availableProjectRef(project: AvailableProject): ScopedProjectRef {
  return scopeProjectRef(project.environmentId, project.id);
}

export function useAvailableProjectContext(): AvailableProjectContext {
  const localProjects = useProjects();
  const { selectedInstanceId } = useActiveWorkjetScope();
  const workjetProjectRegistry = useWorkjetProjectRegistry(selectedInstanceId);
  const workjetConfiguration = usePrimarySettings((settings) => settings.workjet);
  const { environments } = useBusinessOsScopedEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const composerTarget =
    routeTarget?.kind === "server"
      ? routeTarget.threadRef
      : routeTarget?.kind === "draft"
        ? routeTarget.draftId
        : null;
  const routeComposerWorkerId = useComposerDraftStore((store) =>
    composerTarget === null ? null : store.getComposerDraft(composerTarget)?.workjetWorkerId,
  );
  const scopedEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const computers = useMemo(
    () =>
      workjetConfiguration.computers.filter((computer) =>
        scopedEnvironmentIds.has(computer.environmentId),
      ),
    [scopedEnvironmentIds, workjetConfiguration.computers],
  );
  const workerComputerId =
    routeComposerWorkerId === null || routeComposerWorkerId === undefined
      ? null
      : (workjetConfiguration.workerProfiles.find((worker) => worker.id === routeComposerWorkerId)
          ?.computerId ?? null);
  const activeEnvironmentId =
    routeTarget?.kind === "server"
      ? routeTarget.threadRef.environmentId
      : (routeDraftThread?.environmentId ?? primaryEnvironment?.environmentId ?? null);
  const resolvedComputer = resolveWorkjetComputer({
    computers,
    workerModeActive: routeComposerWorkerId !== null && routeComposerWorkerId !== undefined,
    workerComputerId,
    activeEnvironmentId,
    selectedComputerId: workjetConfiguration.selectedComputerId,
  }).computer;
  const availableProjects = useMemo(
    () =>
      buildAvailableProjects({
        projects: localProjects,
        workjetProjects: workjetProjectRegistry.projects,
        computer: resolvedComputer,
        selectedWorkjetProjectId: workjetProjectRegistry.selectedProjectId,
      }),
    [
      localProjects,
      resolvedComputer,
      workjetProjectRegistry.projects,
      workjetProjectRegistry.selectedProjectId,
    ],
  );

  return {
    availableProjects,
    localProjects,
    resolvedComputer,
    workjetProjectRegistry,
    workjetProjects: workjetProjectRegistry.projects,
  };
}

export function useAvailableProjects(): readonly AvailableProject[] {
  return useAvailableProjectContext().availableProjects;
}
