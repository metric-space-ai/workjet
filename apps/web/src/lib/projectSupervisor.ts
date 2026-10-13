import { DEFAULT_RUNTIME_MODE, DEFAULT_WORKJET_THREAD_CONFIG } from "@workjet/contracts";
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

/** The local Projekt-Supervisor thread, as first open and one-click onboarding create it. */
export function projectSupervisorThreadInput<
  TThreadId extends string,
  TProjectId extends string,
  TModel,
>(input: {
  readonly threadId: TThreadId;
  readonly projectId: TProjectId;
  readonly title: string;
  readonly modelSelection: TModel;
  readonly createdAt: string;
}) {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    title: "Projekt-Supervisor",
    modelSelection: input.modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default" as const,
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      role: "orchestrator" as const,
      team: {
        role: "supervisor" as const,
        projectId: input.projectId,
        threadId: input.threadId,
        parentThreadId: null,
        goal: `Coordinate the goals of ${input.title}`,
        createdAt: input.createdAt,
      },
    },
    branch: null,
    worktreePath: null,
    createdAt: input.createdAt,
  };
}
