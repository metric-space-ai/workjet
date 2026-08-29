import type { CtoxWorkjetProjectProjection } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { useActiveWorkjetScope } from "./activeWorkjetScope";
import { listWorkjetProjects } from "./workjetProjectControl";

export interface WorkjetProjectRegistrySnapshot {
  readonly presentationInstanceId: string | null;
  readonly phase: "idle" | "loading" | "ready" | "blocked";
  readonly projects: readonly CtoxWorkjetProjectProjection[];
  readonly selectedProjectId: string | null;
}

const EMPTY_PROJECTS: readonly CtoxWorkjetProjectProjection[] = Object.freeze([]);
let snapshot: WorkjetProjectRegistrySnapshot = {
  presentationInstanceId: null,
  phase: "idle",
  projects: EMPTY_PROJECTS,
  selectedProjectId: null,
};
const listeners = new Set<() => void>();

export function loadingWorkjetProjectRegistry(
  presentationInstanceId: string | null,
): WorkjetProjectRegistrySnapshot {
  return presentationInstanceId === null
    ? {
        presentationInstanceId: null,
        phase: "idle",
        projects: EMPTY_PROJECTS,
        selectedProjectId: null,
      }
    : {
        presentationInstanceId,
        phase: "loading",
        projects: EMPTY_PROJECTS,
        selectedProjectId: null,
      };
}

export function mergeWorkjetProjectProjection(
  current: WorkjetProjectRegistrySnapshot,
  presentationInstanceId: string,
  project: CtoxWorkjetProjectProjection,
): WorkjetProjectRegistrySnapshot {
  if (current.presentationInstanceId !== presentationInstanceId) return current;
  return {
    presentationInstanceId,
    phase: "ready",
    projects: [...current.projects.filter((candidate) => candidate.id !== project.id), project],
    selectedProjectId: current.selectedProjectId,
  };
}

function publish(next: WorkjetProjectRegistrySnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function readWorkjetProjectRegistry(
  presentationInstanceId: string | null,
): WorkjetProjectRegistrySnapshot {
  return snapshot.presentationInstanceId === presentationInstanceId
    ? snapshot
    : loadingWorkjetProjectRegistry(presentationInstanceId);
}

function normalizedWorkingCopyPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
}

export function findWorkjetProjectByWorkingCopy(
  projects: readonly CtoxWorkjetProjectProjection[],
  computerId: string,
  path: string,
): CtoxWorkjetProjectProjection | undefined {
  const normalizedPath = normalizedWorkingCopyPath(path);
  return projects.find((project) =>
    project.workingCopies.some(
      (workingCopy) =>
        workingCopy.computerId === computerId &&
        normalizedWorkingCopyPath(workingCopy.path) === normalizedPath,
    ),
  );
}

export function recordWorkjetProjectProjection(
  presentationInstanceId: string,
  project: CtoxWorkjetProjectProjection,
  options: { readonly select?: boolean } = {},
): boolean {
  if (snapshot.presentationInstanceId !== presentationInstanceId) return false;
  const current = snapshot;
  const next = mergeWorkjetProjectProjection(current, presentationInstanceId, project);
  if (next === snapshot) return false;
  publish({
    ...next,
    selectedProjectId: options.select === true ? project.id : next.selectedProjectId,
  });
  return true;
}

export function selectWorkjetProject(presentationInstanceId: string, projectId: string): boolean {
  if (
    snapshot.presentationInstanceId !== presentationInstanceId ||
    !snapshot.projects.some((project) => project.id === projectId)
  )
    return false;
  if (snapshot.selectedProjectId !== projectId)
    publish({ ...snapshot, selectedProjectId: projectId });
  return true;
}

export function useWorkjetProjectRegistry(
  presentationInstanceId: string | null,
): WorkjetProjectRegistrySnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => readWorkjetProjectRegistry(presentationInstanceId),
    () => readWorkjetProjectRegistry(presentationInstanceId),
  );
}

export function WorkjetProjectRegistrySynchronizer() {
  const { selectedInstanceId: presentationInstanceId } = useActiveWorkjetScope();

  useEffect(() => {
    let cancelled = false;
    publish(loadingWorkjetProjectRegistry(presentationInstanceId));
    if (presentationInstanceId === null) return;
    void listWorkjetProjects(presentationInstanceId).then(
      (result) => {
        if (cancelled) return;
        if (result._tag !== "completed" || result.response.action !== "project.list") {
          publish({
            presentationInstanceId,
            phase: "blocked",
            projects: EMPTY_PROJECTS,
            selectedProjectId: null,
          });
          return;
        }
        const selectedProjectId = result.response.projects.some(
          (project) => project.id === snapshot.selectedProjectId,
        )
          ? snapshot.selectedProjectId
          : (result.response.projects[0]?.id ?? null);
        publish({
          presentationInstanceId,
          phase: "ready",
          projects: result.response.projects,
          selectedProjectId,
        });
      },
      () => {
        if (!cancelled) {
          publish({
            presentationInstanceId,
            phase: "blocked",
            projects: EMPTY_PROJECTS,
            selectedProjectId: null,
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [presentationInstanceId]);
  return null;
}

export function __resetWorkjetProjectRegistryForTests(
  next: WorkjetProjectRegistrySnapshot = loadingWorkjetProjectRegistry(null),
): void {
  publish(next);
}
