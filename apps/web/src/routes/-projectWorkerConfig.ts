import {
  inheritWorkjetThreadSettings,
  type ProjectId,
  type ThreadId,
  type WorkjetThreadConfig,
} from "@workjet/contracts";

export function createPersistentWorkerConfig(input: {
  readonly supervisorConfig: WorkjetThreadConfig;
  readonly projectId: ProjectId;
  readonly supervisorThreadId: ThreadId;
  readonly threadId: ThreadId;
  readonly domain: string;
  readonly goal: string;
  readonly createdAt: string;
}): WorkjetThreadConfig {
  return {
    ...inheritWorkjetThreadSettings(input.supervisorConfig),
    role: "orchestrator",
    parent: null,
    team: {
      role: "specialist",
      projectId: input.projectId,
      threadId: input.threadId,
      parentThreadId: input.supervisorThreadId,
      domain: input.domain,
      goal: input.goal,
      createdAt: input.createdAt,
    },
  };
}
