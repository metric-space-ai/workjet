import { canCreateProjectInEnvironment } from "@workjet/client-runtime/operations/projects";
import type { EnvironmentConnectionPhase } from "@workjet/client-runtime/connection";
import type { EnvironmentId } from "@workjet/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@workjet/client-runtime/state/shell";
import type { ProjectId, ScopedThreadRef } from "@workjet/contracts";

export function resolveProjectSupervisorTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projects: ReadonlyArray<Pick<EnvironmentProject, "id" | "environmentId">>;
  readonly threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      "id" | "environmentId" | "projectId" | "workjetConfig" | "archivedAt" | "deletedAt"
    >
  >;
}):
  | { readonly status: "pending" }
  | { readonly status: "unavailable" | "conflict" }
  | { readonly status: "ready"; readonly thread: ScopedThreadRef } {
  const project = input.projects.find(
    (candidate) =>
      candidate.id === input.projectId && candidate.environmentId === input.environmentId,
  );
  if (!project) return { status: "pending" };
  const supervisors = input.threads.filter(
    (thread) =>
      thread.environmentId === input.environmentId &&
      thread.projectId === input.projectId &&
      thread.workjetConfig.team?.role === "supervisor",
  );
  const active = supervisors.filter((thread) => !thread.archivedAt && !thread.deletedAt);
  if (active.length === 0) {
    return { status: supervisors.length === 0 ? "pending" : "unavailable" };
  }
  if (active.length !== 1) return { status: "conflict" };
  const thread = active[0]!;
  const team = thread.workjetConfig.team!;
  if (
    thread.workjetConfig.role !== "orchestrator" ||
    team.projectId !== input.projectId ||
    team.threadId !== thread.id ||
    team.parentThreadId !== null
  )
    return { status: "conflict" };
  return { status: "ready", thread: { environmentId: input.environmentId, threadId: thread.id } };
}

export function resolveAddProjectEnvironment<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  },
>(environmentOptions: ReadonlyArray<T>, requestedEnvironmentId: EnvironmentId | null): T | null {
  if (requestedEnvironmentId !== null) {
    return (
      environmentOptions.find(
        (environment) =>
          environment.environmentId === requestedEnvironmentId &&
          canCreateProjectInEnvironment(environment.connectionState),
      ) ?? null
    );
  }

  return (
    environmentOptions.find((environment) =>
      canCreateProjectInEnvironment(environment.connectionState),
    ) ?? null
  );
}
