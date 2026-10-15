import type { TurnId, WorkjetThreadGoal, WorkjetWorkerKanban } from "@workjet/contracts";

/** Only explicit protocol absence permits emulation; quota and transport failures retain their guards. */
export function isUnsupportedNativeGoal(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  const value = error as Record<string, unknown>;
  return (
    value.code === -32601 ||
    value._tag === "UnsupportedNativeGoal" ||
    (typeof value.message === "string" &&
      /(?:unsupported|not supported).*goal|goal.*(?:unsupported|not supported)|method (?:not found|.*not.*supported)/i.test(
        value.message,
      )) ||
    isUnsupportedNativeGoal(value.cause, depth + 1)
  );
}

/** Turn text is a report, never a completion or verification receipt. */
export function workerTurnKanbanFallback(
  goal: WorkjetThreadGoal,
  turnId: TurnId,
  reportedResult: string | undefined,
  createdAt: string,
): WorkjetWorkerKanban | undefined {
  if (goal.kanban?.iteration === goal.continuationCount) return undefined;
  return {
    goalRevision: goal.revision,
    iteration: goal.continuationCount,
    cards: [
      ...(goal.kanban?.cards ?? [])
        .filter((card) => card.id !== "workjet-turn-result")
        .slice(0, 29),
      {
        id: "workjet-turn-result",
        status: "doing",
        title:
          reportedResult?.trim().slice(0, 512) || "Worker turn completed without a text report.",
        evidence: `Turn ${turnId}. Workjet retained the reported outcome; goal completion remains unverified.`,
      },
    ],
    updatedAt: createdAt,
  };
}
