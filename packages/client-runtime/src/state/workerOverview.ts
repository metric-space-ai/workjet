import type { EnvironmentId, ThreadId, WorkjetThreadConfig } from "@t3tools/contracts";

/**
 * Minimal structural shape the worker-overview grouping needs from a thread.
 * `EnvironmentThreadShell` and `EnvironmentThread` both satisfy it, so callers
 * pass their full row objects through and keep every presentation field
 * (`title`, `latestTurn`, `modelSelection`, `session`, …) on the grouped result.
 */
export interface WorkerOverviewThreadLike {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly workjetConfig: WorkjetThreadConfig;
}

export interface WorkerOverviewGroup<T extends WorkerOverviewThreadLike> {
  /** The orchestrator thread the workers were dispatched from. */
  readonly orchestrator: T;
  /** Worker child threads, in input order. Always at least one. */
  readonly workers: ReadonlyArray<T>;
}

export interface WorkerThreadGrouping<T extends WorkerOverviewThreadLike> {
  /** One group per orchestrator that has at least one linked worker child. */
  readonly groups: ReadonlyArray<WorkerOverviewGroup<T>>;
  /**
   * Worker threads whose parent orchestrator is missing, deleted, not an
   * orchestrator, or lives in a different environment. These stay visible
   * under an "Unlinked workers" bucket rather than disappearing.
   */
  readonly unlinkedWorkers: ReadonlyArray<T>;
}

function orchestratorKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}

/**
 * Returns true when `thread` is a worker whose parent reference resolves to an
 * orchestrator thread that lives in the same environment.
 *
 * The parent link is only valid when:
 *  - the thread's own `workjetConfig.role` is `"worker"` (non-workers never
 *    join a group),
 *  - the worker sits in the same environment its parent reference names
 *    (a cross-environment parent reference is treated as unlinked), and
 *  - a thread with the referenced id exists in `orchestratorsByKey` and is an
 *    orchestrator (a missing, deleted, or non-orchestrator parent is unlinked).
 */
function resolveParentKey<T extends WorkerOverviewThreadLike>(
  thread: T,
  orchestratorsByKey: ReadonlyMap<string, T>,
): string | null {
  const config = thread.workjetConfig;
  if (config.role !== "worker") {
    return null;
  }
  const parent = config.parent;
  // Same-environment guard: the worker must sit in the environment its parent
  // reference names. Cross-environment references are never linked.
  if (parent.environmentId !== thread.environmentId) {
    return null;
  }
  const key = orchestratorKey(parent.environmentId, parent.threadId);
  return orchestratorsByKey.has(key) ? key : null;
}

/**
 * Read-only grouping of a flat thread list into parent orchestrator → worker
 * children groups, plus an unlinked-workers bucket for orphans.
 *
 * Pure and side-effect free: the same input always yields the same output and
 * the original thread objects are preserved by reference. This is the single
 * authority both web and mobile clients derive the orchestrator worker overview
 * from, so the linking rules cannot drift between renderers.
 */
export function groupWorkerThreads<T extends WorkerOverviewThreadLike>(
  threads: ReadonlyArray<T>,
): WorkerThreadGrouping<T> {
  const orchestratorsByKey = new Map<string, T>();
  for (const thread of threads) {
    if (thread.workjetConfig.role === "orchestrator") {
      orchestratorsByKey.set(orchestratorKey(thread.environmentId, thread.id), thread);
    }
  }

  // Insertion order follows the input orchestrator order; groups only
  // materialize for orchestrators that actually own a worker child.
  const groupsByKey = new Map<string, { orchestrator: T; workers: T[] }>();
  const unlinkedWorkers: T[] = [];

  for (const thread of threads) {
    if (thread.workjetConfig.role !== "worker") {
      continue;
    }
    const parentKey = resolveParentKey(thread, orchestratorsByKey);
    if (parentKey === null) {
      unlinkedWorkers.push(thread);
      continue;
    }
    const existing = groupsByKey.get(parentKey);
    if (existing) {
      existing.workers.push(thread);
    } else {
      groupsByKey.set(parentKey, {
        orchestrator: orchestratorsByKey.get(parentKey)!,
        workers: [thread],
      });
    }
  }

  return {
    groups: Array.from(groupsByKey.values(), (group) => ({
      orchestrator: group.orchestrator,
      workers: group.workers,
    })),
    unlinkedWorkers,
  };
}

/**
 * Convenience selector for the orchestrator-scoped overview surface: the worker
 * children dispatched from one specific orchestrator thread, in input order.
 *
 * Returns an empty array when the thread is not an orchestrator or owns no
 * workers, so the renderer can decide whether to show an empty "Workers (0)"
 * affordance or hide the surface entirely.
 */
export function selectWorkersForOrchestrator<T extends WorkerOverviewThreadLike>(
  threads: ReadonlyArray<T>,
  environmentId: EnvironmentId,
  orchestratorThreadId: ThreadId,
): ReadonlyArray<T> {
  const key = orchestratorKey(environmentId, orchestratorThreadId);
  const orchestrator = threads.find(
    (thread) =>
      thread.workjetConfig.role === "orchestrator" &&
      orchestratorKey(thread.environmentId, thread.id) === key,
  );
  if (!orchestrator) {
    return [];
  }
  const orchestratorsByKey = new Map<string, T>([[key, orchestrator]]);
  return threads.filter((thread) => resolveParentKey(thread, orchestratorsByKey) === key);
}
