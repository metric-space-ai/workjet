import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  type OrchestrationReadModel,
  type ProjectId,
  type ThreadId,
  type WorkjetThreadConfig,
} from "@workjet/contracts";

/** Multi-turn provider fixtures represent persistent team members, never one-shot workers. */
export function persistentThreadConfigForTest(
  model: OrchestrationReadModel,
  projectId: ProjectId,
  threadId: ThreadId,
  config: WorkjetThreadConfig = DEFAULT_WORKJET_THREAD_CONFIG,
): WorkjetThreadConfig {
  const supervisor = model.threads.find(
    (thread) =>
      thread.projectId === projectId &&
      thread.workjetConfig.schemaVersion === 2 &&
      thread.workjetConfig.team?.role === "supervisor",
  );
  if (!supervisor)
    throw new Error("The persistent fixture requires the project's actual supervisor.");
  return {
    ...DEFAULT_WORKJET_THREAD_CONFIG,
    ...config,
    schemaVersion: 2,
    role: "standard",
    parent: null,
    team: {
      role: "specialist",
      projectId,
      threadId,
      parentThreadId: supervisor.id,
      domain: `provider-lifecycle-${threadId}`,
      goal: "Retain the conversation across provider turns.",
      createdAt: supervisor.createdAt,
    },
  };
}
