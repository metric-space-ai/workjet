import type { TurnId, WorkjetThreadGoal, WorkjetWorkerKanban } from "@workjet/contracts";

/** Turn text is a report, never a completion or verification receipt. */
export function workerTurnKanbanFallback(
  goal: WorkjetThreadGoal, turnId: TurnId, reportedResult: string | undefined, createdAt: string,
): WorkjetWorkerKanban | undefined {
  if (goal.kanban?.iteration === goal.continuationCount) return undefined;
  return {
    goalRevision: goal.revision,
    iteration: goal.continuationCount,
    cards: [
      ...(goal.kanban?.cards ?? []).filter(card => card.id !== 'workjet-turn-result').slice(0, 29),
      { id: 'workjet-turn-result', status: 'doing',
        title: reportedResult?.trim().slice(0, 512) || 'Worker turn completed without a text report.',
        evidence: `Turn ${turnId}. Workjet retained the reported outcome; goal completion remains unverified.` },
    ],
    updatedAt: createdAt,
  };
}
