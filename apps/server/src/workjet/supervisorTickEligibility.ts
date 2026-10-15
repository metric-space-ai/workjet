import type { OrchestrationProject, OrchestrationThread } from "@workjet/contracts";

/** Shared by collection and atomic admission so invalid bindings trigger no source reads. */
export function isSupervisorTickEligible(
  thread: OrchestrationThread,
  project: OrchestrationProject | undefined,
): boolean {
  const config = thread.workjetConfig;
  return (
    config.schemaVersion === 2 &&
    config.team?.role === "supervisor" &&
    config.team.projectId === thread.projectId &&
    config.team.threadId === thread.id &&
    thread.deletedAt === null &&
    thread.archivedAt === null &&
    project !== undefined &&
    project.id === thread.projectId &&
    project.deletedAt === null &&
    !project.overview?.archived
  );
}
