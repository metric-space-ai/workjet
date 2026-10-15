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
    `Iteration ${goal.continuationCount}: If workjet_worker_kanban is available, update your retained worker mini-kanban exactly once with action update at the start. Include todo/doing/done/blocked cards, measured facts, owner, evidence, commit/PR link and next trigger. If unavailable, continue the substantive work: Workjet records a server-side mini-kanban from your turn result. A missing tool is never a precondition or a blocker.`,
    "Use the retained context and results. A turn ending is not goal completion. Continue substantive work and verification.",
    "When the goal is verified complete, call the available workjet_update_goal (or harness-native goal tool) with status complete and the result/evidence. For a concrete external blocker, call it with status blocked and the exact decision needed. Do not mark ordinary resource waits blocked.",
  ].join("\n\n");
}
