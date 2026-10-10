import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@workjet/contracts";
export function readModelForTest(): OrchestrationReadModel {
  const createdAt = "2026-10-10T00:00:00.000Z";
  const projectId = ProjectId.make("fixture-project");
  const parentId = ThreadId.make("fixture-parent");
  const id = ThreadId.make("fixture-worker");
  const base: OrchestrationThread = {
    id,
    projectId,
    title: "[Worker1@Project supervisor]: gpt-6.1-sol",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
    branch: `workjet/worker/${id}`,
    worktreePath: "/owned/worktree",
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
  return {
    snapshotSequence: 0,
    updatedAt: createdAt,
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "/source/project",
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        faviconPath: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      },
    ],
    threads: [
      {
        ...base,
        workjetConfig: {
          schemaVersion: 2,
          role: "worker",
          parent: { environmentId: EnvironmentId.make("local"), threadId: parentId },
          managedInstructions: "",
          enabledCapabilityIds: [],
          capabilityBindings: [],
          ctoxSession: null,
          team: {
            role: "worker",
            threadId: id,
            parentThreadId: parentId,
            projectId,
            packageId: "one-shot",
            goal: "A single PR",
            createdAt,
          },
        },
      },
      {
        ...base,
        id: parentId,
        title: "Project supervisor",
        branch: null,
        worktreePath: null,
        workjetConfig: {
          schemaVersion: 2,
          role: "standard",
          parent: null,
          managedInstructions: "",
          enabledCapabilityIds: [],
          capabilityBindings: [],
          ctoxSession: null,
          team: {
            role: "supervisor",
            threadId: parentId,
            projectId,
            parentThreadId: null,
            goal: "Own the project",
            createdAt,
          },
        },
      },
    ],
  };
}
