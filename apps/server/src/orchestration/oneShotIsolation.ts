import type { OrchestrationReadModel, OrchestrationThread } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

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
