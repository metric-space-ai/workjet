import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/shell";
import type { ScopedProjectRef } from "@workjet/contracts";

/** Projects always open their retained main contact rather than minting another draft. */
export function findProjectSupervisor(
  threads: readonly EnvironmentThreadShell[],
  project: ScopedProjectRef,
): EnvironmentThreadShell | null {
  return (
    threads.find(
      (thread) =>
        thread.environmentId === project.environmentId &&
        thread.projectId === project.projectId &&
        thread.archivedAt === null &&
        thread.workjetConfig.schemaVersion === 2 &&
        thread.workjetConfig.team?.role === "supervisor",
    ) ?? null
  );
}
