import { CtoxWorkjetProjectProjection, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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
const WORKJET_PROJECT_REGISTRY_STORAGE_PREFIX = "workjet:project-registry:v1:";
const PersistedWorkjetProjectRegistry = Schema.Struct({
  version: Schema.Literal(1),
  selectedProjectId: Schema.NullOr(ProjectId),
  projects: Schema.Array(CtoxWorkjetProjectProjection).check(Schema.isMaxLength(10_000)),
});
const decodePersistedWorkjetProjectRegistry = Schema.decodeUnknownSync(
  PersistedWorkjetProjectRegistry,
);
const IDLE_SNAPSHOT: WorkjetProjectRegistrySnapshot = Object.freeze({
  presentationInstanceId: null,
  phase: "idle",
  projects: EMPTY_PROJECTS,
  selectedProjectId: null,
});
const loadingSnapshots = new Map<string, WorkjetProjectRegistrySnapshot>();
let snapshot: WorkjetProjectRegistrySnapshot = IDLE_SNAPSHOT;
const listeners = new Set<() => void>();

function registryStorageKey(presentationInstanceId: string): string {
  return `${WORKJET_PROJECT_REGISTRY_STORAGE_PREFIX}${encodeURIComponent(presentationInstanceId)}`;
}

function readPersistedSnapshot(
  presentationInstanceId: string,
): WorkjetProjectRegistrySnapshot | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(registryStorageKey(presentationInstanceId));
    if (raw === null) return null;
    const persisted = decodePersistedWorkjetProjectRegistry(JSON.parse(raw));
    const selectedProjectId = persisted.projects.some(
      (project) => project.id === persisted.selectedProjectId,
    )
      ? persisted.selectedProjectId
      : (persisted.projects[0]?.id ?? null);
    return Object.freeze({
      presentationInstanceId,
      phase: "ready",
      projects: Object.freeze([...persisted.projects]),
      selectedProjectId,
    });
  } catch {
    return null;
  }
}

function persistSnapshot(next: WorkjetProjectRegistrySnapshot): void {
  if (
    typeof localStorage === "undefined" ||
    next.presentationInstanceId === null ||
    next.phase !== "ready"
  )
    return;
  try {
    localStorage.setItem(
      registryStorageKey(next.presentationInstanceId),
      JSON.stringify({
        version: 1,
        projects: next.projects,
        selectedProjectId: next.selectedProjectId,
      }),
    );
  } catch {
    // The confirmed in-memory projection remains usable when persistence is unavailable.
  }
}

export function loadingWorkjetProjectRegistry(
  presentationInstanceId: string | null,
): WorkjetProjectRegistrySnapshot {
  if (presentationInstanceId === null) return IDLE_SNAPSHOT;
  const cached = loadingSnapshots.get(presentationInstanceId);
  if (cached) return cached;
  const persisted = readPersistedSnapshot(presentationInstanceId);
  if (persisted !== null) {
    loadingSnapshots.set(presentationInstanceId, persisted);
    return persisted;
  }
  const next: WorkjetProjectRegistrySnapshot = Object.freeze({
    presentationInstanceId,
    phase: "loading",
    projects: EMPTY_PROJECTS,
    selectedProjectId: null,
  });
  loadingSnapshots.set(presentationInstanceId, next);
  return next;
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
  if (next.presentationInstanceId !== null) {
    loadingSnapshots.set(next.presentationInstanceId, next);
  }
  persistSnapshot(next);
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
          const current = readWorkjetProjectRegistry(presentationInstanceId);
          if (current.projects.length === 0)
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
          const current = readWorkjetProjectRegistry(presentationInstanceId);
          if (current.projects.length === 0)
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
  loadingSnapshots.clear();
  publish(next);
}
