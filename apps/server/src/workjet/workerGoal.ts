import {
  CommandId,
  MessageId,
  type ThreadId,
  type TurnId,
  type WorkjetThreadGoal,
  type WorkjetThreadConfig,
} from "@workjet/contracts";

/** Client settings/creates carry intent, never producer or verifier witnesses. */
export function withoutGoalObservations(config: WorkjetThreadConfig): WorkjetThreadConfig {
  if (config.schemaVersion !== 2 || !config.goal) return config;
  const goal = { ...config.goal };
  delete goal.lastExecution;
  delete goal.executor;
  goal.lastVerifiedProgress = null;
  return { ...config, goal };
}

export function initialWorkerGoal(objective: string, updatedAt: string): WorkjetThreadGoal {
  return {
    objective,
    status: "active",
    revision: 0,
    continuationCount: 0,
    lastCompletedTurnId: null,
    lastVerifiedProgress: null,
    pendingContinuation: null,
    reason: null,
    updatedAt,
  };
}

export function prepareGoalContinuation(
  threadId: ThreadId,
  goal: WorkjetThreadGoal,
  completedTurnId: TurnId,
  createdAt: string,
): WorkjetThreadGoal {
  const key = `server:goal:${threadId}:${goal.revision}:${completedTurnId}`;
  return {
    ...goal,
    revision: goal.revision + 1,
    continuationCount: goal.continuationCount + 1,
    lastCompletedTurnId: completedTurnId,
    updatedAt: createdAt,
    pendingContinuation: {
      commandId: CommandId.make(key),
      messageId: MessageId.make(key),
      createdAt,
    },
  };
}

export function workerGoalContinuationText(goal: WorkjetThreadGoal): string {
  return [
    "Continue working towards your active Workjet goal:",
    goal.objective,
    `Iteration ${goal.continuationCount}: before any other work, update your retained slide-engine mini-kanban exactly once with workjet_worker_kanban, action update. Include the current todo/doing/done/blocked cards and measured facts, owner, evidence, commit/PR link and next trigger in the title/evidence fields.`,
    "Use the retained context and results. A turn ending is not goal completion. Continue substantive work and verification.",
    "When the goal is verified complete, call workjet_update_goal with status complete and the result/evidence. For a concrete external blocker, call it with status blocked and the exact decision needed. Do not mark ordinary resource waits blocked.",
  ].join("\n\n");
}
