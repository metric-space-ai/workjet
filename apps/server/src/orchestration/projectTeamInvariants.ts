import type {
  OrchestrationReadModel,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkjetThreadConfig,
  RemoteWorkerRequest,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** Enforced inside serialized command dispatch, before any events are persisted. */
export function requireProjectTeamOwnership(input: {
  readonly commandType: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly config: WorkjetThreadConfig;
  readonly readModel: OrchestrationReadModel;
  readonly environmentId?: EnvironmentId | undefined;
  readonly remoteWorkerRequest?: RemoteWorkerRequest | undefined;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const { config, readModel, threadId, projectId } = input;
  const team = config.schemaVersion === 2 ? config.team : undefined;
  const current = readModel.threads.find((thread) => thread.id === threadId);
  const previous =
    current?.workjetConfig.schemaVersion === 2 ? current.workjetConfig.team : undefined;
  const fail = (detail: string) =>
    Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.commandType,
        detail,
      }),
    );
  if (
    previous &&
    (!team || previous.role !== team.role || previous.parentThreadId !== team.parentThreadId)
  ) {
    return fail("Project team role and parent ownership cannot be silently removed or reassigned.");
  }
  if (current?.workjetConfig.role === "worker" && config.role !== "worker") {
    return fail("A dispatched worker cannot promote itself to a parent role.");
  }
  if (
    config.role === "worker" &&
    input.environmentId !== undefined &&
    config.parent.environmentId !== input.environmentId
  ) {
    const request = input.remoteWorkerRequest;
    if (
      !request ||
      request.requestId !== threadId ||
      request.project.id !== projectId ||
      request.targetEnvironmentId !== input.environmentId ||
      request.parent.environmentId !== config.parent.environmentId ||
      request.parent.threadId !== config.parent.threadId ||
      request.parent.threadId === threadId ||
      new Set(config.enabledCapabilityIds).size !== config.enabledCapabilityIds.length ||
      config.enabledCapabilityIds.some((id) => !request.enabledCapabilityIds.includes(id)) ||
      request.enabledCapabilityIds.some((id) => !request.parentCapabilityIds.includes(id)) ||
      (request.parentTeamRole !== undefined &&
        (team?.role !== "worker" ||
          team.threadId !== threadId ||
          team.projectId !== projectId ||
          team.parentThreadId !== request.parent.threadId ||
          team.packageId !== threadId)) ||
      (request.parentTeamRole === undefined && team !== undefined)
    )
      return fail(
        "A remote worker requires its immutable native dispatch receipt and exact source parent.",
      );
    return Effect.void;
  }
  if (!team) return Effect.void;

  if (
    previous?.role === "worker" &&
    team.role === "worker" &&
    previous.packageId !== team.packageId
  ) {
    return fail("A worker package identity cannot be reassigned.");
  }
  if (
    current?.workjetConfig.role === "worker" &&
    config.role === "worker" &&
    current.workjetConfig.parent.environmentId !== config.parent.environmentId
  ) {
    return fail("A worker parent environment cannot be reassigned.");
  }
  if (team.threadId !== threadId || team.projectId !== projectId) {
    return fail("Project team membership must match its persisted thread and project.");
  }
  if (team.role === "supervisor") {
    if (config.role === "worker")
      return fail("A one-shot worker cannot become a project supervisor.");
    const existing = readModel.threads.some(
      (thread) =>
        thread.id !== threadId &&
        thread.projectId === projectId &&
        thread.workjetConfig.schemaVersion === 2 &&
        thread.workjetConfig.team?.role === "supervisor",
    );
    return existing ? fail("This project already has a durable supervisor.") : Effect.void;
  }
  if (team.parentThreadId === threadId) return fail("A project team member cannot own itself.");
  const parent = readModel.threads.find((thread) => thread.id === team.parentThreadId);
  const parentTeam =
    parent?.workjetConfig.schemaVersion === 2 ? parent.workjetConfig.team : undefined;
  if (
    !parent ||
    parent.deletedAt !== null ||
    parent.archivedAt !== null ||
    parent.projectId !== projectId
  ) {
    return fail("The project team parent must be an active thread in the same project.");
  }
  if (team.role === "specialist") {
    if (config.role === "worker" || parentTeam?.role !== "supervisor") {
      return fail("A Persistent Worker must be owned by the project supervisor.");
    }
    if (
      readModel.threads.some((thread) => {
        const other =
          thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
        return (
          thread.id !== threadId &&
          thread.projectId === projectId &&
          thread.deletedAt === null &&
          other?.role === "specialist" &&
          other.domain.toLowerCase() === team.domain.toLowerCase()
        );
      })
    )
      return fail("This project already has a specialist for that domain.");
  } else if (
    config.role !== "worker" ||
    config.parent.threadId !== team.parentThreadId ||
    !input.environmentId ||
    config.parent.environmentId !== input.environmentId ||
    (parentTeam?.role !== "specialist" && parentTeam?.role !== "supervisor")
  ) {
    return fail(
      "A project worker must be owned by a supervisor or specialist and cannot spawn children.",
    );
  }
  return Effect.void;
}

/** Team lifecycle authorization belongs to the serialized decider, never the UI. */
export function requireProjectTeamLifecycle(input: {
  readonly commandType: "thread.archive" | "thread.delete";
  readonly thread: OrchestrationReadModel["threads"][number];
  readonly readModel: OrchestrationReadModel;
  readonly allowTeamTermination?: boolean;
  readonly workerCleanupComplete?: boolean;
  /** Supplied only after the engine reads the exact native terminal-PR receipt. */
  readonly workerExecutionStopped?: boolean;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const { commandType, thread, readModel } = input;
  if (commandType === "thread.delete" && input.allowTeamTermination) return Effect.void;
  const team = thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
  const fail = (detail: string) =>
    Effect.fail(new OrchestrationCommandInvariantError({ commandType, detail }));
  if (team?.role === "supervisor") {
    return fail(
      commandType === "thread.delete"
        ? "The project supervisor is retained until the project is deleted."
        : "The project supervisor remains available as the main contact.",
    );
  }
  if (
    commandType === "thread.archive" &&
    team?.role === "worker" &&
    !input.workerExecutionStopped &&
    (thread.deletedAt === null || !input.workerCleanupComplete)
  ) {
    return fail(
      "A One-Shot Worker requires a verified submitted PR with stopped execution or completed merge cleanup.",
    );
  }
  if (
    readModel.threads.some(
      (child) =>
        child.deletedAt === null &&
        (commandType === "thread.delete" || child.archivedAt === null) &&
        child.workjetConfig.schemaVersion === 2 &&
        child.workjetConfig.team?.parentThreadId === thread.id,
    )
  ) {
    return fail(
      commandType === "thread.delete"
        ? "A team parent with retained child threads cannot be deleted."
        : "A team parent with active child threads cannot be archived.",
    );
  }
  return Effect.void;
}
