import type { OrchestrationThreadShell, VcsStatusResult } from "@workjet/contracts";

/** Fail closed rather than silently dropping user changes when moving execution. */
export function validateManualWorkerSource(
  thread: OrchestrationThreadShell,
  threads: readonly OrchestrationThreadShell[],
  status: VcsStatusResult,
): { readonly branch: string; readonly resuming: boolean } {
  const branch = `workjet/worker/${thread.id}`;
  const resuming = thread.branch === branch && thread.worktreePath !== null;
  if (thread.worktreePath && !resuming)
    throw new Error("Existing checkout ownership is ambiguous; preserve its work and create an isolated worker explicitly.");
  if (resuming && threads.some((other) => other.id !== thread.id && other.worktreePath === thread.worktreePath))
    throw new Error("Worker checkout is shared; execution is refused.");
  if (!status.isRepo || !status.hasPrimaryRemote || !status.hasUpstream || status.aheadCount > 0 || status.hasWorkingTreeChanges)
    throw new Error("Project source must be clean and published before an isolated worker starts; existing work is preserved.");
  return { branch, resuming };
}
