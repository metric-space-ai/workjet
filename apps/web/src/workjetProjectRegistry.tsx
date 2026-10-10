import {
  CtoxWorkjetProjectProjection,
  type CtoxWorkjetProjectControlResult,
  type EnvironmentId,
  ProjectId,
  type WorkjetComputer,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useSyncExternalStore } from "react";

import { useActiveWorkjetScope, subscribeActiveWorkjetHostContext } from "./activeWorkjetScope";
import { useHydratePrimaryWorkjetSettings } from "./hooks/useSettings";
import { listWorkjetProjects } from "./workjetProjectControl";
import { LocalProjectRegistrationSynchronizer } from "./localProjectRegistration";
import {
  createProjectRegistryRefresh,
  subscribeProjectRegistryWarmGuest,
} from "./projectRegistryRefresh";

export interface WorkjetProjectRegistrySnapshot {
  readonly presentationInstanceId: string | null;
  readonly phase: "idle" | "loading" | "ready" | "blocked";
  readonly projects: readonly CtoxWorkjetProjectProjection[];
  readonly selectedProjectId: string | null;
  readonly refreshFailed?: boolean;
  readonly lastUpdatedAt?: number | undefined;
  readonly refreshError?: Extract<CtoxWorkjetProjectControlResult, { _tag: "failed" }>;
}

const EMPTY_PROJECTS: readonly CtoxWorkjetProjectProjection[] = Object.freeze([]);
const WORKJET_PROJECT_REGISTRY_STORAGE_PREFIX = "workjet:project-registry:v1:";
const REFRESH_PROJECT_REGISTRY_EVENT = "workjet:refresh-project-registry";

/** A confirmed project change wakes the coalesced, automatically recovering synchronizer. */
export function refreshWorkjetProjectRegistry(instanceId: string | null): void {
  if (instanceId !== null)
    window.dispatchEvent(new CustomEvent(REFRESH_PROJECT_REGISTRY_EVENT, { detail: instanceId }));
}
const PersistedWorkjetProjectRegistry = Schema.Struct({
  version: Schema.Literal(1),
  lastUpdatedAt: Schema.optionalKey(Schema.Number),
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

export function resolveSelectedWorkjetProjectId(
  projects: readonly CtoxWorkjetProjectProjection[],
  selectedProjectId: string | null,
): string | null {
  return projects.some((project) => project.id === selectedProjectId) ? selectedProjectId : null;
}

function readPersistedSnapshot(
  presentationInstanceId: string,
): WorkjetProjectRegistrySnapshot | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(registryStorageKey(presentationInstanceId));
    if (raw === null) return null;
    const persisted = decodePersistedWorkjetProjectRegistry(JSON.parse(raw));
    const selectedProjectId = resolveSelectedWorkjetProjectId(
      persisted.projects,
      persisted.selectedProjectId,
    );
    return Object.freeze({
      presentationInstanceId,
      phase: "ready",
      projects: Object.freeze([...persisted.projects]),
      lastUpdatedAt: persisted.lastUpdatedAt,
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
        lastUpdatedAt: next.lastUpdatedAt,
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

export interface WorkjetComputerResolution {
  readonly computer: WorkjetComputer | null;
  readonly source: "worker" | "environment" | "selected" | null;
}

export function resolveLocalWorkjetComputer(input: {
  readonly resolvedComputer: WorkjetComputer | null;
  readonly computers: ReadonlyArray<WorkjetComputer>;
  readonly localEnvironmentId: EnvironmentId | null;
}): WorkjetComputer | null {
  if (
    input.resolvedComputer !== null &&
    input.resolvedComputer.environmentId === input.localEnvironmentId
  ) {
    return input.resolvedComputer;
  }

  return (
    input.computers.find((computer) => computer.environmentId === input.localEnvironmentId) ?? null
  );
}

export function resolveLocalWorkjetWorkingCopy(input: {
  readonly resolvedComputer: WorkjetComputer | null;
  readonly computers: ReadonlyArray<WorkjetComputer>;
  readonly localEnvironmentId: EnvironmentId | null;
  readonly path: string;
}): { readonly computerId: WorkjetComputer["id"]; readonly path: string } | null {
  const computer = resolveLocalWorkjetComputer(input);
  return computer === null ? null : { computerId: computer.id, path: input.path };
}

export function resolveWorkjetComputer(input: {
  readonly computers: ReadonlyArray<WorkjetComputer>;
  readonly workerModeActive: boolean;
  readonly workerComputerId: string | null;
  readonly activeEnvironmentId: EnvironmentId | null;
  readonly selectedComputerId: string | null;
}): WorkjetComputerResolution {
  if (input.workerModeActive && input.workerComputerId !== null) {
    const workerComputer = input.computers.find(
      (computer) => computer.id === input.workerComputerId,
    );
    if (workerComputer !== undefined) {
      return { computer: workerComputer, source: "worker" };
    }
  }

  const environmentComputer = input.computers.find(
    (computer) => computer.environmentId === input.activeEnvironmentId,
  );
  if (environmentComputer !== undefined) {
    return { computer: environmentComputer, source: "environment" };
  }

  if (input.selectedComputerId !== null) {
    const selectedComputer = input.computers.find(
      (computer) => computer.id === input.selectedComputerId,
    );
    if (selectedComputer !== undefined) {
      return { computer: selectedComputer, source: "selected" };
    }
  }

  return { computer: null, source: null };
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

export function selectWorkjetProject(
  presentationInstanceId: string,
  projectId: string | null,
): boolean {
  if (
    snapshot.presentationInstanceId !== presentationInstanceId ||
    (projectId !== null && !snapshot.projects.some((project) => project.id === projectId))
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

/** A failed refresh retains this instance's saved projects and selected history. */
export function applyWorkjetProjectRegistryResult(
  presentationInstanceId: string,
  result: CtoxWorkjetProjectControlResult,
): void {
  if (snapshot.presentationInstanceId !== presentationInstanceId) return;
  const current = readWorkjetProjectRegistry(presentationInstanceId);
  if (result._tag !== "completed" || result.response.action !== "project.list") {
    publish({
      ...current,
      phase: current.projects.length === 0 ? "blocked" : "ready",
      refreshFailed: true,
      ...(result._tag === "failed" ? { refreshError: result } : {}),
    });
    return;
  }
  publish({
    presentationInstanceId,
    phase: "ready",
    projects: result.response.projects,
    lastUpdatedAt: Date.now(),
    selectedProjectId: resolveSelectedWorkjetProjectId(
      result.response.projects,
      current.selectedProjectId,
    ),
  });
}

export function WorkjetProjectRegistrySynchronizer() {
  useHydratePrimaryWorkjetSettings();
  const { selectedInstanceId: presentationInstanceId } = useActiveWorkjetScope();

  useEffect(() => {
    let cancelled = false;
    const restored = loadingWorkjetProjectRegistry(presentationInstanceId);
    publish(restored);
    if (presentationInstanceId === null) return;
    const refreshController = createProjectRegistryRefresh(() =>
      listWorkjetProjects(presentationInstanceId).then(
        (result) => {
          if (cancelled) return;
          applyWorkjetProjectRegistryResult(presentationInstanceId, result);
          return result._tag === "completed" && result.response.action === "project.list";
        },
        () => {
          if (!cancelled) {
            applyWorkjetProjectRegistryResult(presentationInstanceId, {
              _tag: "failed",
              code: "guest_failed",
            });
          }
          return false;
        },
      ),
    );
    const refresh = () => {
      void refreshController.refresh();
    };
    const unsubscribeGuest = subscribeProjectRegistryWarmGuest(
      presentationInstanceId,
      refresh,
      window.desktopBridge?.ctox?.onGuestState,
    );
    const onRequest = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === presentationInstanceId) refresh();
    };
    const unsubscribeHostContext = subscribeActiveWorkjetHostContext(refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener(REFRESH_PROJECT_REGISTRY_EVENT, onRequest);
    refresh();
    return () => {
      cancelled = true;
      refreshController.cancel();
      unsubscribeGuest();
      unsubscribeHostContext();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener(REFRESH_PROJECT_REGISTRY_EVENT, onRequest);
    };
  }, [presentationInstanceId]);
  return <LocalProjectRegistrationSynchronizer />;
}

export function __resetWorkjetProjectRegistryForTests(
  next: WorkjetProjectRegistrySnapshot = loadingWorkjetProjectRegistry(null),
): void {
  loadingSnapshots.clear();
  publish(next);
}
