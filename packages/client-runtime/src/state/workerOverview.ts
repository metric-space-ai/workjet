import type { EnvironmentId, ThreadId, WorkjetThreadConfig } from "@workjet/contracts";

/** Minimal shared shell shape; grouped rows retain their original identities and fields. */
export interface WorkerOverviewThreadLike {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly workjetConfig: WorkjetThreadConfig;
  readonly archivedAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
}

export interface WorkerOverviewGroup<T extends WorkerOverviewThreadLike> {
  readonly orchestrator: T;
  readonly workers: ReadonlyArray<T>;
}

export interface WorkerThreadGrouping<T extends WorkerOverviewThreadLike> {
  readonly groups: ReadonlyArray<WorkerOverviewGroup<T>>;
  /** Missing, deleted or non-orchestrator parents remain visible as unlinked workers. */
  readonly unlinkedWorkers: ReadonlyArray<T>;
}

function orchestratorKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return JSON.stringify([environmentId, threadId]);
}

function isVisible(thread: WorkerOverviewThreadLike): boolean {
  return thread.archivedAt == null && thread.deletedAt == null;
}

/** Resolves the exact parent pair, including registered remote environments. */
function resolveParentKey<T extends WorkerOverviewThreadLike>(
  thread: T,
  orchestratorsByKey: ReadonlyMap<string, T>,
): string | null {
  const config = thread.workjetConfig;
  if (config.role !== "worker" || !isVisible(thread)) return null;
  const key = orchestratorKey(config.parent.environmentId, config.parent.threadId);
  return orchestratorsByKey.has(key) ? key : null;
}

/** Pure grouping shared by clients. Archived and deleted rows stay out of the live overview. */
export function groupWorkerThreads<T extends WorkerOverviewThreadLike>(
  threads: ReadonlyArray<T>,
): WorkerThreadGrouping<T> {
  const orchestratorsByKey = new Map<string, T>();
  for (const thread of threads) {
    if (thread.workjetConfig.role === "orchestrator" && isVisible(thread)) {
      orchestratorsByKey.set(orchestratorKey(thread.environmentId, thread.id), thread);
    }
  }
  const groupsByKey = new Map<string, { orchestrator: T; workers: T[] }>();
  const unlinkedWorkers: T[] = [];
  for (const thread of threads) {
    if (thread.workjetConfig.role !== "worker" || !isVisible(thread)) continue;
    const parentKey = resolveParentKey(thread, orchestratorsByKey);
    if (parentKey === null) {
      unlinkedWorkers.push(thread);
      continue;
    }
    const existing = groupsByKey.get(parentKey);
    if (existing) existing.workers.push(thread);
    else groupsByKey.set(parentKey, { orchestrator: orchestratorsByKey.get(parentKey)!, workers: [thread] });
  }
  return { groups: Array.from(groupsByKey.values()), unlinkedWorkers };
}

/** Worker rows for one real orchestrator; navigation uses each worker's own environment. */
export function selectWorkersForOrchestrator<T extends WorkerOverviewThreadLike>(
  threads: ReadonlyArray<T>,
  environmentId: EnvironmentId,
  orchestratorThreadId: ThreadId,
): ReadonlyArray<T> {
  const key = orchestratorKey(environmentId, orchestratorThreadId);
  const orchestrator = threads.find(
    (thread) => thread.workjetConfig.role === "orchestrator" && isVisible(thread) &&
      orchestratorKey(thread.environmentId, thread.id) === key,
  );
  if (!orchestrator) return [];
  const orchestratorsByKey = new Map<string, T>([[key, orchestrator]]);
  return threads.filter((thread) => resolveParentKey(thread, orchestratorsByKey) === key);
}

/**
 * Existing physical/logical project scopes still select their own rows. A remote
 * PR worker also belongs to its source scope when its real parent and matching
 * project/team identities resolve there. This never creates a local surrogate.
 * Inputs come only from the client's authenticated registered environments.
 */
export function selectThreadsForProjectScope<
  T extends WorkerOverviewThreadLike & { readonly projectId: string },
>(threads: ReadonlyArray<T>, projectKeys: ReadonlySet<string> | null): ReadonlyArray<T> {
  if (projectKeys === null) return threads.filter(isVisible);
  const inScope = (thread: T) => projectKeys.has(`${thread.environmentId}:${thread.projectId}`);
  const parents = new Map<string, T>();
  for (const thread of threads) {
    if (!isVisible(thread) || !inScope(thread) || thread.workjetConfig.role !== "orchestrator") continue;
    const team = thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
    if (team?.projectId !== thread.projectId || team.threadId !== thread.id ||
      (team.role !== "supervisor" && team.role !== "specialist")) continue;
    parents.set(orchestratorKey(thread.environmentId, thread.id), thread);
  }
  return threads.filter((thread) => {
    if (!isVisible(thread)) return false;
    if (inScope(thread)) return true;
    const config = thread.workjetConfig;
    if (config.schemaVersion !== 2 || config.role !== "worker") return false;
    const team = config.team;
    const parent = parents.get(orchestratorKey(config.parent.environmentId, config.parent.threadId));
    return parent !== undefined && thread.environmentId !== parent.environmentId &&
      thread.projectId === parent.projectId && team?.role === "worker" &&
      team.projectId === thread.projectId && team.threadId === thread.id &&
      team.parentThreadId === parent.id;
  });
}
