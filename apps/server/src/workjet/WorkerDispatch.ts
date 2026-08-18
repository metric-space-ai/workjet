import {
  CommandId,
  MessageId,
  ThreadId,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationCommand,
  type WorkjetCapabilityId,
  type WorkjetParentThreadReference,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export interface WorkerDispatchInput {
  readonly task: string;
  readonly title?: string;
  readonly enabledCapabilityIds?: ReadonlyArray<WorkjetCapabilityId>;
  readonly modelSelection?: ModelSelection;
}

export interface WorkerDispatchResult {
  readonly schemaVersion: 1;
  readonly status: "dispatched";
  readonly environmentId: EnvironmentId;
  readonly workerThreadId: ThreadId;
  readonly parent: WorkjetParentThreadReference;
  readonly modelSelection: ModelSelection;
  readonly enabledCapabilityIds: ReadonlyArray<WorkjetCapabilityId>;
}

export type WorkerDispatchFailureReason =
  | "role-not-authorized"
  | "parent-unavailable"
  | "parent-not-orchestrator"
  | "duplicate-capabilities"
  | "capability-escalation"
  | "worktree-failed"
  | "create-failed"
  | "turn-start-failed"
  | "rollback-failed";

export class WorkerDispatchError extends Schema.TaggedErrorClass<WorkerDispatchError>()(
  "WorkerDispatchError",
  {
    reason: Schema.Literals([
      "role-not-authorized",
      "parent-unavailable",
      "parent-not-orchestrator",
      "duplicate-capabilities",
      "capability-escalation",
      "worktree-failed",
      "create-failed",
      "turn-start-failed",
      "rollback-failed",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "role-not-authorized":
        return "Worker dispatch is not authorized for this provider session.";
      case "parent-unavailable":
        return "The parent thread is unavailable for worker dispatch.";
      case "parent-not-orchestrator":
        return "The parent thread is no longer an orchestrator.";
      case "duplicate-capabilities":
        return "Worker capability selections must not contain duplicates.";
      case "capability-escalation":
        return "The requested worker capabilities exceed the parent grants.";
      case "worktree-failed":
        return "The isolated worker worktree could not be created.";
      case "create-failed":
        return "The worker thread could not be created.";
      case "turn-start-failed":
        return "The worker thread was rolled back after its first turn could not start.";
      case "rollback-failed":
        return "The worker turn failed and its rollback also failed.";
    }
  }
}

export interface WorkerDispatchShape {
  readonly dispatch: (
    invocation: McpInvocationScope,
    input: WorkerDispatchInput,
  ) => Effect.Effect<WorkerDispatchResult, WorkerDispatchError>;
}

export class WorkerDispatch extends Context.Service<WorkerDispatch, WorkerDispatchShape>()(
  "t3/workjet/WorkerDispatch",
) {}

export interface WorkerDispatchSources {
  readonly randomUUID: Effect.Effect<string>;
  readonly nowIso: Effect.Effect<string>;
}

const DEFAULT_TITLE_MAX_LENGTH = 120;

/**
 * Namespace for isolated worker branches. The worker thread id is a v4 UUID, so
 * the resulting ref is collision-resistant across concurrent dispatches and
 * gives `WorktreeStorage.resolveAutomaticPath` a distinct per-worker directory.
 */
export const WORKER_REF_PREFIX = "workjet/worker/";

export const deriveWorkerTitle = (task: string): string => {
  const normalized = task.trim().replace(/\s+/g, " ");
  if (normalized.length <= DEFAULT_TITLE_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, DEFAULT_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
};

const failure = (reason: WorkerDispatchFailureReason) => new WorkerDispatchError({ reason });

export const makeWorkerDispatchWithSources = Effect.fn("WorkerDispatch.makeWithSources")(function* (
  sources: WorkerDispatchSources,
) {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;

  const dispatch: WorkerDispatchShape["dispatch"] = Effect.fn("WorkerDispatch.dispatch")(
    function* (invocation, input) {
      if (invocation.workjetRole !== "orchestrator") {
        return yield* failure("role-not-authorized");
      }

      const parentOption = yield* query
        .getThreadDetailById(invocation.threadId)
        .pipe(Effect.mapError(() => failure("parent-unavailable")));
      const parent = Option.getOrUndefined(parentOption);
      if (!parent || parent.deletedAt !== null) {
        return yield* failure("parent-unavailable");
      }
      if (parent.workjetConfig.role !== "orchestrator") {
        return yield* failure("parent-not-orchestrator");
      }

      const enabledCapabilityIds = input.enabledCapabilityIds
        ? [...input.enabledCapabilityIds]
        : [...parent.workjetConfig.enabledCapabilityIds];
      if (input.enabledCapabilityIds) {
        if (new Set(enabledCapabilityIds).size !== enabledCapabilityIds.length) {
          return yield* failure("duplicate-capabilities");
        }
        const parentGrants = new Set(parent.workjetConfig.enabledCapabilityIds);
        if (enabledCapabilityIds.some((capabilityId) => !parentGrants.has(capabilityId))) {
          return yield* failure("capability-escalation");
        }
      }

      const modelSelection = input.modelSelection ?? parent.modelSelection;
      const parentReference = {
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
      } as const;
      const workerThreadId = ThreadId.make(yield* sources.randomUUID);
      const createCommandId = CommandId.make(yield* sources.randomUUID);
      const turnStartCommandId = CommandId.make(yield* sources.randomUUID);
      const messageId = MessageId.make(yield* sources.randomUUID);
      const createdAt = yield* sources.nowIso;
      const title = input.title?.trim() || deriveWorkerTitle(input.task);

      // The owner decision of 2026-08-17 rejects worktree inheritance: parallel
      // workers must never share a checkout. Every worker therefore gets its own
      // Git worktree beneath the server-authoritative storage root, branched
      // from the orchestrator's current ref.
      const gitCwd =
        parent.worktreePath ??
        (yield* query.getProjectShellById(parent.projectId).pipe(
          Effect.map(
            (projectOption) => Option.getOrUndefined(projectOption)?.workspaceRoot ?? null,
          ),
          Effect.orElseSucceed(() => null),
        ));
      if (gitCwd === null) {
        return yield* failure("worktree-failed");
      }
      const workerRefName = `${WORKER_REF_PREFIX}${workerThreadId}`;
      const workerWorktree = yield* gitWorkflow
        .createWorktree({
          cwd: gitCwd,
          // `path: null` routes the location through WorktreeStorage, keeping the
          // worker checkout beneath the operator-selected storage root.
          path: null,
          refName: parent.branch ?? "HEAD",
          newRefName: workerRefName,
        })
        .pipe(
          Effect.map((created) => created.worktree),
          Effect.mapError(() => failure("worktree-failed")),
        );
      // Only ever remove what this dispatch created, and only when a rollback
      // actually runs. `git worktree remove` leaves the branch behind, so the
      // throwaway worker ref is deleted too — otherwise every rolled-back
      // dispatch would leak a dangling `workjet/worker/<uuid>`.
      const removeWorkerWorktree = Effect.suspend(() =>
        gitWorkflow.removeWorktree({ cwd: gitCwd, path: workerWorktree.path, force: true }).pipe(
          // Lazy: the ref is only deleted once the worktree is actually gone.
          Effect.andThen(() =>
            gitWorkflow.deleteBranch({ cwd: gitCwd, refName: workerRefName, force: true }),
          ),
        ),
      ).pipe(Effect.exit);

      const createCommand = {
        type: "thread.create",
        commandId: createCommandId,
        threadId: workerThreadId,
        projectId: parent.projectId,
        title,
        modelSelection,
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        workjetConfig: {
          schemaVersion: 1,
          role: "worker",
          parent: parentReference,
          managedInstructions: parent.workjetConfig.managedInstructions,
          enabledCapabilityIds,
        },
        branch: workerWorktree.refName,
        worktreePath: workerWorktree.path,
        createdAt,
      } as const satisfies OrchestrationCommand;

      const createExit = yield* Effect.exit(engine.dispatch(createCommand));
      if (createExit._tag === "Failure") {
        yield* removeWorkerWorktree;
        return yield* failure("create-failed");
      }

      const turnStartCommand = {
        type: "thread.turn.start",
        commandId: turnStartCommandId,
        threadId: workerThreadId,
        message: {
          messageId,
          role: "user",
          text: input.task,
          attachments: [],
        },
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        createdAt,
      } as const satisfies OrchestrationCommand;

      const turnStartExit = yield* Effect.exit(engine.dispatch(turnStartCommand));
      if (turnStartExit._tag === "Failure") {
        const rollbackCommand = {
          type: "thread.delete",
          commandId: CommandId.make(yield* sources.randomUUID),
          threadId: workerThreadId,
        } as const satisfies OrchestrationCommand;
        const rollbackExit = yield* Effect.exit(engine.dispatch(rollbackCommand));
        const worktreeRollbackExit = yield* removeWorkerWorktree;
        return yield* failure(
          rollbackExit._tag === "Failure" || worktreeRollbackExit._tag === "Failure"
            ? "rollback-failed"
            : "turn-start-failed",
        );
      }

      return {
        schemaVersion: 1,
        status: "dispatched",
        environmentId: invocation.environmentId,
        workerThreadId,
        parent: parentReference,
        modelSelection,
        enabledCapabilityIds,
      } as const;
    },
  );

  return WorkerDispatch.of({ dispatch });
});

export const makeWorkerDispatch = Effect.fn("WorkerDispatch.make")(function* () {
  const crypto = yield* Crypto.Crypto;
  return yield* makeWorkerDispatchWithSources({
    randomUUID: crypto.randomUUIDv4.pipe(Effect.orDie),
    nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
  });
});

export const layer = Layer.effect(WorkerDispatch, makeWorkerDispatch());
