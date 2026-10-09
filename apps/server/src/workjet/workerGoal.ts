import { CommandId, MessageId, type ThreadId, type TurnId, type WorkjetThreadGoal } from "@workjet/contracts";

export function initialWorkerGoal(objective: string, updatedAt: string): WorkjetThreadGoal {
  return {
    objective, status: "active", revision: 0, continuationCount: 0,
    lastCompletedTurnId: null, pendingContinuation: null, reason: null, updatedAt,
  };
}

export function prepareGoalContinuation(
  threadId: ThreadId, goal: WorkjetThreadGoal, completedTurnId: TurnId, createdAt: string,
): WorkjetThreadGoal {
  const key = `server:goal:${threadId}:${goal.revision}:${completedTurnId}`;
  return {
    ...goal, revision: goal.revision + 1, continuationCount: goal.continuationCount + 1,
    lastCompletedTurnId: completedTurnId, updatedAt: createdAt,
    pendingContinuation: { commandId: CommandId.make(key), messageId: MessageId.make(key), createdAt },
  };
}

export function workerGoalContinuationText(goal: WorkjetThreadGoal): string {
  return [
    "Continue working towards your active Workjet goal:",
    goal.objective,
    "Use the retained context and results. A turn ending is not goal completion. Continue substantive work and verification.",
    "When the goal is verified complete, call workjet_update_goal with status complete and the result/evidence. For a concrete external blocker, call it with status blocked and the exact decision needed. Do not mark ordinary resource waits blocked.",
  ].join("\n\n");
}
