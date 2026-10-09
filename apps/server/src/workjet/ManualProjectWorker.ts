import {
  normalizeWorkjetThreadConfig,
  type EnvironmentId,
  type OrchestrationThreadShell,
  type WorkjetThreadConfig,
} from "@workjet/contracts";

/** Standalone chats have no project supervisor and keep their ordinary behavior. */
export function manualProjectWorkerParent(
  thread: OrchestrationThreadShell,
  threads: readonly OrchestrationThreadShell[],
): OrchestrationThreadShell | undefined {
  const config = normalizeWorkjetThreadConfig(thread.workjetConfig);
  if (config.role === "worker" || config.team) return;
  const parents = threads.filter((candidate) =>
    candidate.id !== thread.id && candidate.projectId === thread.projectId &&
    candidate.archivedAt === null && candidate.deletedAt == null &&
    candidate.workjetConfig.schemaVersion === 2 &&
    candidate.workjetConfig.team?.role === "supervisor",
  );
  if (parents.length > 1) throw new Error("Project has multiple supervisors; resolve ownership before starting this worker.");
  if (parents[0] && thread.latestTurn !== null)
    throw new Error("This existing project chat already ran in its previous checkout. Preserve its history and work; explicit isolated-worker migration is required before continuing.");
  return parents[0];
}

export function manualProjectWorkerConfig(
  thread: OrchestrationThreadShell,
  parent: OrchestrationThreadShell,
  environmentId: EnvironmentId,
  goal: string,
): WorkjetThreadConfig {
  return {
    ...normalizeWorkjetThreadConfig(thread.workjetConfig),
    schemaVersion: 2,
    role: "worker",
    parent: { environmentId, threadId: parent.id },
    team: {
      role: "worker", projectId: thread.projectId, threadId: thread.id,
      parentThreadId: parent.id, packageId: `manual:${thread.id}`,
      goal: goal.trim().slice(0, 4096) || thread.title,
      createdAt: thread.createdAt,
    },
  };
}
