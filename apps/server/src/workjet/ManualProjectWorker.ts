import {
  canCoordinateWorkjet,
  normalizeWorkjetThreadConfig,
  type EnvironmentId,
  type OrchestrationThreadShell,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";

export class ManualProjectWorkerSetupError extends Schema.TaggedErrorClass<ManualProjectWorkerSetupError>()(
  "ManualProjectWorkerSetupError",
  { message: Schema.String },
) {}

/** Only explicitly commissioned, unprepared workers enter the isolated-worker bootstrap. */
export function manualProjectWorkerParent(
  thread: OrchestrationThreadShell,
  threads: readonly OrchestrationThreadShell[],
): OrchestrationThreadShell | undefined {
  const config = normalizeWorkjetThreadConfig(thread.workjetConfig);
  // Project affiliation and a user-selected checkout do not commission a worker.
  // Dispatched team workers already own their WorkerDispatch checkout.
  if (config.role !== "worker" || config.team) return;
  const parents = threads.filter(
    (candidate) =>
      candidate.id === config.parent.threadId &&
      candidate.id !== thread.id &&
      candidate.projectId === thread.projectId &&
      candidate.archivedAt === null &&
      candidate.deletedAt == null &&
      canCoordinateWorkjet(candidate.workjetConfig),
  );
  if (parents.length === 0)
    throw new Error(
      "The One-Shot Worker's coordinating parent is unavailable. Restore its parent before starting the worker.",
    );
  if (parents.length > 1)
    throw new Error(
      "Worker parent ownership is ambiguous; resolve ownership before starting this worker.",
    );
  if (parents[0] && thread.latestTurn !== null)
    throw new Error(
      "This existing project chat already ran in its previous checkout. Preserve its history and work; explicit isolated-worker migration is required before continuing.",
    );
  return parents[0];
}

export function manualProjectWorkerConfig(
  thread: OrchestrationThreadShell,
  parent: OrchestrationThreadShell,
  environmentId: EnvironmentId,
  goal: string,
): WorkjetThreadConfig {
  return {
    ...normalizeWorkjetThreadConfig(thread.workjetConfig),
    schemaVersion: 2,
    role: "worker",
    parent: { environmentId, threadId: parent.id },
    team: {
      role: "worker",
      projectId: thread.projectId,
      threadId: thread.id,
      parentThreadId: parent.id,
      packageId: `manual:${thread.id}`,
      goal: goal.trim().slice(0, 4096) || thread.title,
      createdAt: thread.createdAt,
    },
  };
}
