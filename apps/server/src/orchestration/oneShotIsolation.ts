import {
  canCoordinateWorkjet,
  normalizeWorkjetThreadConfig,
  type EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** Only explicit agent provenance commissions a roleless chat as a One-Shot. */
export const resolveOneShotCreationConfig = Effect.fn("resolveOneShotCreationConfig")(function* (
  command: Extract<OrchestrationCommand, { type: "thread.create" }>,
  model: OrchestrationReadModel,
  environmentId: EnvironmentId | undefined,
): Effect.fn.Return<WorkjetThreadConfig, OrchestrationCommandInvariantError> {
  const config = normalizeWorkjetThreadConfig(command.workjetConfig);
  if (config.role !== "standard" || (config.team && config.team.role !== "worker"))
    return command.workjetConfig;
  const parentId = command.createdByThreadId ?? config.team?.parentThreadId;
  if (!parentId) return command.workjetConfig;
  const parent = model.threads.find((thread) => thread.id === parentId);
  if (
    !environmentId ||
    !parent ||
    parent.id === command.threadId ||
    parent.projectId !== command.projectId ||
    parent.deletedAt !== null ||
    parent.archivedAt !== null ||
    !canCoordinateWorkjet(parent.workjetConfig) ||
    (config.team && config.team.parentThreadId !== parentId)
  ) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail:
        "Agent-created project chats require an active Supervisor or Persistent Worker in the same project and a local environment identity.",
    });
  }
  return {
    ...config,
    role: "worker",
    parent: { environmentId, threadId: parentId },
    team: config.team ?? {
      role: "worker",
      projectId: command.projectId,
      threadId: command.threadId,
      parentThreadId: parentId,
      packageId: `manual:${command.threadId}`,
      goal: command.title,
      createdAt: command.createdAt,
    },
  };
});

/** The engine also fences internal/CLI starts which do not pass through the UI bootstrap. */
export function requireOneShotIsolation(
  thread: OrchestrationThread,
  model: OrchestrationReadModel,
) {
  const team = thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
  const fail = (detail: string) =>
    Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: "thread.turn.start",
        detail,
      }),
    );
  if (!team && thread.workjetConfig.role === "worker")
    return fail(
      "A manual project One-Shot Worker must be prepared in its own worktree before execution.",
    );
  if (team?.role !== "worker") return Effect.void;
  if (
    thread.workjetConfig.role !== "worker" ||
    team.threadId !== thread.id ||
    team.projectId !== thread.projectId ||
    team.parentThreadId !== thread.workjetConfig.parent.threadId ||
    thread.branch !== `workjet/worker/${thread.id}` ||
    thread.worktreePath === null ||
    model.projects.some((project) => project.workspaceRoot === thread.worktreePath) ||
    model.threads.some(
      (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
    )
  )
    return fail(
      "A One-Shot Worker requires its own canonical branch and an exclusively owned worktree.",
    );
  return Effect.void;
}
