import * as NodeUtil from "node:util";
import {
  CommandId,
  MessageId,
  ThreadId,
  WorkjetDelegationId,
  WorkjetEnvelopeId,
  WorkjetRepositoryPath,
  RemoteWorkerRequest,
  type WorkjetDelegation,
  type EnvironmentId,
  ModelSelection,
  type OrchestrationCommand,
  type WorkjetCapabilityId,
  type WorkjetComputerId,
  type WorkjetParentThreadReference,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveDelegatedCapabilities } from "@metric-space-ai/workjet-capabilities";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { RemoteWorkerBroker } from "./RemoteWorkerBroker.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { WorkjetSnapshotStore } from "./mailbox/WorkjetSnapshotStore.ts";
import { WorkjetMeshIdentity } from "./mailbox/WorkjetMeshIdentity.ts";
import { WorkjetMailboxStore } from "./mailbox/WorkjetMailboxStore.ts";
import { WorkerDispatchRollback, type WorkerDispatchRecovery } from "./WorkerDispatchRollback.ts";
import type { OrchestrationDispatchOptions } from "../orchestration/Services/OrchestrationEngine.ts";

export interface WorkerDispatchInput {
  readonly task: string;
  /** Retry only this saved remote request after a lost acknowledgement. */
  readonly remoteRequestId?: ThreadId;
  readonly computerId?: WorkjetComputerId;
  readonly title?: string;
  readonly enabledCapabilityIds?: ReadonlyArray<WorkjetCapabilityId>;
  readonly modelSelection?: ModelSelection;
}

export interface WorkerDispatchResult {
  readonly schemaVersion: 1;
  readonly status: "dispatched";
  readonly environmentId: EnvironmentId;
  readonly workerThreadId: ThreadId;
  readonly computerId?: WorkjetComputerId;
  readonly branch: string;
  readonly worktreePath: string;
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
  | "computer-unavailable"
  | "remote-dispatch-unavailable"
  | "remote-dispatch-pending"
  | "remote-dispatch-failed"
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
      "computer-unavailable",
      "remote-dispatch-unavailable",
      "remote-dispatch-pending",
      "remote-dispatch-failed",
      "worktree-failed",
      "create-failed",
      "turn-start-failed",
      "rollback-failed",
    ]),
    remoteRequestId: Schema.optional(ThreadId),
    targetEnvironmentId: Schema.optional(Schema.String),
    recoveryWorktreePath: Schema.optional(Schema.String),
    recoveryAdminPath: Schema.optional(Schema.String),
    originalWorktreePath: Schema.optional(Schema.String),
    originalAdminPath: Schema.optional(Schema.String),
    recoveryLocationStatus: Schema.optional(Schema.Literals(["candidate", "verified"])),
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
      case "computer-unavailable":
        return "The selected worker computer is unavailable in native settings.";
      case "remote-dispatch-unavailable":
        return "The registered remote environment connection is unavailable.";
      case "remote-dispatch-pending":
        return "Remote worker dispatch is saved and pending. Retry with remoteRequestId to reconcile this worker.";
      case "remote-dispatch-failed":
        return "The remote worker request was rejected. Its saved receipt contains the outcome.";
      case "worktree-failed":
        return "The isolated worker worktree could not be created.";
      case "create-failed":
        return "The worker thread could not be created.";
      case "turn-start-failed":
        return "The worker thread was rolled back after its first turn could not start.";
      case "rollback-failed":
        return "Worker dispatch failed and its rollback could not complete; retained work requires recovery.";
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
  "workjet/workjet/WorkerDispatch",
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

const failure = (reason: WorkerDispatchFailureReason, recovery?: Partial<WorkerDispatchRecovery>) =>
  new WorkerDispatchError({ reason, ...recovery });

export const makeWorkerDispatchWithSources = Effect.fn("WorkerDispatch.makeWithSources")(function* (
  sources: WorkerDispatchSources,
) {
  const engine = yield* OrchestrationEngineService;
  const receipts = yield* Effect.serviceOption(OrchestrationCommandReceiptRepository);
  const query = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const snapshotStore = yield* Effect.serviceOption(WorkjetSnapshotStore);
  const meshIdentity = yield* Effect.serviceOption(WorkjetMeshIdentity);
  const mailbox = yield* Effect.serviceOption(WorkjetMailboxStore);
  const rollback = yield* WorkerDispatchRollback;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const remoteBroker = yield* Effect.serviceOption(RemoteWorkerBroker);
  const sourceGit = yield* Effect.serviceOption(GitVcsDriver);

  const dispatch: WorkerDispatchShape["dispatch"] = Effect.fn("WorkerDispatch.dispatch")(
    function* (invocation, input) {
      if (invocation.workjetRole !== "orchestrator") {
        return yield* failure("role-not-authorized");
      }

      const parentOption = yield* query
        .getThreadDetailById(invocation.threadId)
        .pipe(Effect.mapError(() => failure("parent-unavailable")));
      const parent = Option.getOrUndefined(parentOption);
      if (!parent || parent.deletedAt !== null || parent.archivedAt != null) {
        return yield* failure("parent-unavailable");
      }
      if (parent.workjetConfig.role !== "orchestrator") {
        return yield* failure("parent-not-orchestrator");
      }
      const parentTeam =
        parent.workjetConfig.schemaVersion === 2 ? parent.workjetConfig.team : undefined;
      if (parentTeam && parentTeam.role !== "specialist" && parentTeam.role !== "supervisor") {
        return yield* failure("role-not-authorized");
      }

      const requestedCapabilityIds = input.enabledCapabilityIds
        ? [...input.enabledCapabilityIds]
        : undefined;
      const delegated = resolveDelegatedCapabilities({
        parentCapabilityIds: parent.workjetConfig.enabledCapabilityIds,
        ...(requestedCapabilityIds ? { requestedCapabilityIds } : {}),
        targetRole: "worker",
      });
      const enabledCapabilityIds = [...delegated.capabilityIds] as WorkjetCapabilityId[];
      if (requestedCapabilityIds !== undefined) {
        if (new Set(requestedCapabilityIds).size !== requestedCapabilityIds.length) {
          return yield* failure("duplicate-capabilities");
        }
        const parentGrants = new Set(parent.workjetConfig.enabledCapabilityIds);
        if (
          requestedCapabilityIds.some((capabilityId) => !parentGrants.has(capabilityId)) ||
          delegated.issues.length > 0
        ) {
          return yield* failure("capability-escalation");
        }
      }

      // A computer ID is an explicit catalog binding, never a hostname or an
      // inferred transport. A foreign selection is relayed to that registered
      // environment; it never creates a worker on the source computer.
      let computerId = input.computerId;
      let targetEnvironmentId = invocation.environmentId;
      if (Option.isSome(settings)) {
        const configuration = yield* settings.value.getSettings.pipe(
          Effect.map((current) => current.workjet),
          Effect.mapError(() => failure("computer-unavailable")),
        );
        computerId ??= configuration.selectedComputerId ?? undefined;
        if (computerId === undefined) {
          const localComputers = configuration.computers.filter(
            (computer) => computer.environmentId === invocation.environmentId,
          );
          if (localComputers.length === 1) computerId = localComputers[0]?.id;
        }
        if (computerId !== undefined) {
          const matches = configuration.computers.filter((computer) => computer.id === computerId);
          if (matches.length !== 1) return yield* failure("computer-unavailable");
          targetEnvironmentId = matches[0]!.environmentId;
        }
      } else if (computerId !== undefined) {
        return yield* failure("computer-unavailable");
      }

      const modelSelection = input.modelSelection ?? parent.modelSelection;
      if (targetEnvironmentId !== invocation.environmentId) {
        if (Option.isNone(remoteBroker) || Option.isNone(sourceGit) || computerId === undefined) {
          return yield* failure("remote-dispatch-unavailable");
        }
        const broker = remoteBroker.value;
        let request: RemoteWorkerRequest;
        if (input.remoteRequestId) {
          const saved = yield* broker.read(input.remoteRequestId).pipe(
            Effect.mapError(() => failure("remote-dispatch-failed")),
          );
          if (Option.isNone(saved) || saved.value.request.parent.environmentId !== invocation.environmentId ||
            saved.value.request.parent.threadId !== parent.id || saved.value.request.computerId !== computerId ||
            saved.value.request.targetEnvironmentId !== targetEnvironmentId || saved.value.request.task !== input.task ||
            (input.title !== undefined && saved.value.request.title !== (input.title.trim() || deriveWorkerTitle(input.task))) ||
            (input.modelSelection !== undefined && !NodeUtil.isDeepStrictEqual(
              Schema.encodeSync(ModelSelection)(saved.value.request.modelSelection),
              Schema.encodeSync(ModelSelection)(input.modelSelection),
            )) || (input.enabledCapabilityIds !== undefined &&
              (saved.value.request.enabledCapabilityIds.length !== enabledCapabilityIds.length ||
               saved.value.request.enabledCapabilityIds.some((id) => !enabledCapabilityIds.includes(id))))) {
            return yield* failure("remote-dispatch-failed");
          }
          request = saved.value.request;
        } else {
          const project = Option.getOrUndefined(yield* query.getProjectShellById(parent.projectId).pipe(
            Effect.mapError(() => failure("remote-dispatch-failed")),
          ));
          const cwd = parent.worktreePath ?? project?.workspaceRoot;
          if (!project?.repositoryIdentity || !cwd) return yield* failure("remote-dispatch-failed");
          const status = yield* gitWorkflow.localStatus({ cwd }).pipe(
            Effect.mapError(() => failure("remote-dispatch-failed")),
          );
          // Do not silently discard unpublished source edits on another host.
          if (!status.isRepo || status.hasWorkingTreeChanges) return yield* failure("remote-dispatch-failed");
          const revision = (yield* sourceGit.value.execute({
            operation: "WorkerDispatch.remoteSourceRevision", cwd, args: ["rev-parse", "HEAD"],
            timeoutMs: 5000, maxOutputBytes: 128,
          }).pipe(Effect.mapError(() => failure("remote-dispatch-failed")))).stdout.trim();
          const createdAt = yield* sources.nowIso;
          const { rootPath: _sourcePath, ...repository } = project.repositoryIdentity;
          const remoteUrl = repository.locator.remoteUrl.replace(/^git@github\.com:/, "https://github.com/");
          request = yield* Schema.decodeUnknownEffect(RemoteWorkerRequest)({
            schemaVersion: 1, requestId: ThreadId.make(yield* sources.randomUUID),
            targetEnvironmentId, computerId,
            parent: { environmentId: invocation.environmentId, threadId: parent.id },
            ...(parentTeam ? { parentTeamRole: parentTeam.role } : {}),
            parentCapabilityIds: [...parent.workjetConfig.enabledCapabilityIds],
            managedInstructions: parent.workjetConfig.managedInstructions,
            project: { id: project.id, title: project.title, repository: {
              ...repository, locator: { ...repository.locator, remoteUrl },
            } },
            revision, task: input.task, title: input.title?.trim() || deriveWorkerTitle(input.task),
            modelSelection, runtimeMode: parent.runtimeMode, interactionMode: parent.interactionMode,
            enabledCapabilityIds, createdAt,
            expiresAt: DateTime.makeUnsafe(createdAt).pipe(DateTime.add({ days: 7 }), DateTime.formatIso),
          }).pipe(Effect.mapError(() => failure("remote-dispatch-failed")));
          yield* broker.enqueue(request).pipe(Effect.mapError(() => failure("remote-dispatch-failed")));
        }
        const response = yield* broker.awaitResponse(request.requestId).pipe(
          Effect.timeout("4 minutes"),
          Effect.mapError(() => new WorkerDispatchError({
            reason: "remote-dispatch-pending", remoteRequestId: request.requestId, targetEnvironmentId,
          })),
        );
        if (response.outcome.status === "failed") return yield* new WorkerDispatchError({
          reason: response.outcome.reason === "rollback-failed" ? "rollback-failed" : "remote-dispatch-failed",
          remoteRequestId: request.requestId, targetEnvironmentId,
        });
        return response.outcome.result;
      }
      if (input.remoteRequestId) return yield* failure("remote-dispatch-failed");

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
      let preparedDelegation: OrchestrationDispatchOptions["workerDelegation"];
      if (parentTeam) {
        if (Option.isNone(snapshotStore) || Option.isNone(meshIdentity)) {
          return yield* failure("create-failed");
        }
        const identity = meshIdentity.value;
        const snapshot = yield* snapshotStore.value
          .put(input.task)
          .pipe(Effect.mapError(() => failure("create-failed")));
        const expiresAt = DateTime.makeUnsafe(createdAt).pipe(
          DateTime.add({ days: 7 }),
          DateTime.formatIso,
        );
        const envelopeId = WorkjetEnvelopeId.make(`wjm-worker-${workerThreadId}`);
        const source = {
          schemaVersion: 1 as const,
          workspaceId: identity.workspaceId,
          environmentId: invocation.environmentId,
          threadId: parent.id,
        };
        const target = { ...source, threadId: workerThreadId };
        const delegation = {
          schemaVersion: 1,
          delegationId: WorkjetDelegationId.make(`wjd-worker-${workerThreadId}`),
          envelopeId,
          source,
          target,
          createdAt,
          expiresAt,
          prompt: {
            schemaVersion: 1,
            snapshotRef: snapshot.snapshotRef,
            digest: snapshot.digest,
            byteLength: snapshot.byteLength,
          },
          scope: {
            schemaVersion: 1,
            // A worker without a narrower file selection owns the isolated
            // checkout root. The mailbox contract requires an explicit scope.
            files: [WorkjetRepositoryPath.make(".")],
            nonGoals: "Do not perform work outside the assigned task.",
          },
          completion: {
            schemaVersion: 1,
            acceptance:
              "Complete the task in the verified prompt snapshot and return implementation and verification evidence.",
          },
          budget: { schemaVersion: 1, maxDepth: 1, maxReviewRounds: 2, expiresAt },
          state: "queued",
          stateChangedAt: createdAt,
          depth: 0,
        } as const satisfies WorkjetDelegation;
        const envelope = yield* identity
          .signRoutingEnvelope({
            schemaVersion: 1,
            envelopeId,
            kind: "delegation",
            sourceWorkspaceId: source.workspaceId,
            sourceEnvironmentId: source.environmentId,
            targetWorkspaceId: target.workspaceId,
            targetEnvironmentId: target.environmentId,
            createdAt,
            expiresAt,
          })
          .pipe(Effect.mapError(() => failure("create-failed")));
        preparedDelegation = { envelope, delegation };
      }

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
      const dispatchedResult = {
        schemaVersion: 1,
        status: "dispatched",
        environmentId: invocation.environmentId,
        workerThreadId,
        ...(computerId !== undefined ? { computerId } : {}),
        branch: workerWorktree.refName,
        worktreePath: workerWorktree.path,
        parent: parentReference,
        modelSelection,
        enabledCapabilityIds,
      } as const satisfies WorkerDispatchResult;
      const preparedRollback = yield* rollback
        .prepare({
          cwd: gitCwd,
          worktreePath: workerWorktree.path,
          branchRef: workerRefName,
        })
        .pipe(Effect.option);
      const requireRejected = Effect.fn("WorkerDispatch.requireRejected")(function* (
        commandId: CommandId,
      ) {
        if (Option.isNone(receipts)) return yield* failure("rollback-failed");
        const receipt = yield* receipts.value.getByCommandId({ commandId }).pipe(
          Effect.mapError(() => failure("rollback-failed")),
          Effect.map(Option.getOrUndefined),
        );
        if (
          receipt?.aggregateKind !== "thread" ||
          receipt.aggregateId !== workerThreadId ||
          receipt.status !== "rejected"
        ) {
          return yield* failure("rollback-failed");
        }
      });
      const removeWorkerWorktree = (commandId: CommandId) =>
        Effect.gen(function* () {
          yield* requireRejected(commandId);
          if (Option.isNone(preparedRollback)) return yield* failure("rollback-failed");
          if (commandId === createCommandId) {
            const existing = yield* query.getThreadDetailById(workerThreadId).pipe(
              Effect.mapError(() => failure("rollback-failed")),
              Effect.map(Option.getOrUndefined),
            );
            // A collision must not remove a checkout another saved thread owns.
            if (existing?.worktreePath === workerWorktree.path)
              return yield* failure("rollback-failed");
          }
          return yield* preparedRollback.value.pipe(
            Effect.mapError((error) =>
              failure("rollback-failed", {
                ...(error.originalWorktreePath
                  ? { originalWorktreePath: error.originalWorktreePath }
                  : {}),
                ...(error.originalAdminPath ? { originalAdminPath: error.originalAdminPath } : {}),
                ...(error.recoveryLocationStatus
                  ? { recoveryLocationStatus: error.recoveryLocationStatus }
                  : {}),
                ...(error.recoveryWorktreePath
                  ? { recoveryWorktreePath: error.recoveryWorktreePath }
                  : {}),
                ...(error.recoveryAdminPath ? { recoveryAdminPath: error.recoveryAdminPath } : {}),
              }),
            ),
          );
        }).pipe(Effect.exit);

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
          schemaVersion: 2,
          role: "worker",
          parent: parentReference,
          managedInstructions: parent.workjetConfig.managedInstructions,
          enabledCapabilityIds,
          capabilityBindings: [],
          ...(parentTeam
            ? {
                team: {
                  projectId: parent.projectId,
                  threadId: workerThreadId,
                  role: "worker" as const,
                  parentThreadId: parent.id,
                  packageId: workerThreadId,
                  goal: input.task.trim().slice(0, 4096),
                  createdAt,
                },
              }
            : {}),
        },
        branch: workerWorktree.refName,
        worktreePath: workerWorktree.path,
        createdAt,
      } as const satisfies OrchestrationCommand;

      let createExit = yield* Effect.exit(
        engine.dispatch(
          createCommand,
          preparedDelegation ? { workerDelegation: preparedDelegation } : undefined,
        ),
      );
      if (createExit._tag === "Failure" && preparedDelegation) {
        // One bounded replay uses the same receipt identity. If the commit
        // succeeded but acknowledgement failed, the engine returns its receipt.
        createExit = yield* Effect.exit(
          engine.dispatch(createCommand, { workerDelegation: preparedDelegation }),
        );
      }
      if (createExit._tag === "Failure") {
        if (preparedDelegation) {
          // Both acknowledgements may be lost after the atomic commit. The
          // receipt is written in that transaction, so it resolves ownership
          // without starting a second delegation or discarding its checkout.
          if (Option.isSome(receipts)) {
            const receiptRead = yield* Effect.result(
              receipts.value.getByCommandId({ commandId: createCommandId }),
            );
            if (receiptRead._tag === "Success") {
              const receipt = Option.getOrUndefined(receiptRead.success);
              if (receipt?.aggregateKind === "thread" && receipt.aggregateId === workerThreadId) {
                if (receipt.status === "accepted") {
                  return dispatchedResult;
                }
                if (receipt.status === "rejected") {
                  const cleanupExit = yield* removeWorkerWorktree(createCommandId);
                  if (cleanupExit._tag === "Failure")
                    return yield* Effect.failCause(cleanupExit.cause);
                  return yield* failure("create-failed", cleanupExit.value);
                }
              }
            }
          }
          // A committed team create also stores its worker and delegation in
          // one transaction. When the receipt lookup itself is unavailable,
          // those two durable records can prove that the worker was accepted.
          // Neither record alone is sufficient: an unrelated thread or a
          // partially observed projection must never turn a failed dispatch
          // into a successful one.
          if (Option.isSome(mailbox)) {
            const delegationRead = yield* Effect.result(
              mailbox.value.getDelegation(preparedDelegation.delegation.delegationId),
            );
            if (delegationRead._tag === "Success") {
              const committed = Option.getOrUndefined(delegationRead.success);
              if (
                committed?.delegation.source.threadId === parent.id &&
                committed.delegation.target.threadId === workerThreadId &&
                committed.delegation.envelopeId === preparedDelegation.delegation.envelopeId
              ) {
                const workerRead = yield* Effect.result(query.getThreadDetailById(workerThreadId));
                if (workerRead._tag === "Success") {
                  const worker = Option.getOrUndefined(workerRead.success);
                  if (
                    worker?.id === workerThreadId &&
                    worker.projectId === parent.projectId &&
                    worker.deletedAt === null &&
                    worker.archivedAt === null &&
                    worker.branch === workerRefName &&
                    worker.worktreePath === workerWorktree.path &&
                    worker.workjetConfig.schemaVersion === 2 &&
                    worker.workjetConfig.role === "worker" &&
                    worker.workjetConfig.parent?.environmentId === invocation.environmentId &&
                    worker.workjetConfig.parent?.threadId === parent.id &&
                    worker.workjetConfig.team?.projectId === parent.projectId &&
                    worker.workjetConfig.team?.threadId === workerThreadId &&
                    worker.workjetConfig.team?.parentThreadId === parent.id
                  ) {
                    return dispatchedResult;
                  }
                }
              }
            }
          }
          // A missing or unreadable receipt is still ambiguous: keep the
          // checkout for recovery rather than risk deleting committed work.
          return yield* failure("rollback-failed");
        }
        const cleanupExit = yield* removeWorkerWorktree(createCommandId);
        if (cleanupExit._tag === "Failure") return yield* Effect.failCause(cleanupExit.cause);
        return yield* failure("create-failed", cleanupExit.value);
      }

      // Thread and queued delegation have one durable receipt. The existing
      // executor alone starts the turn and returns its result after a restart.
      if (preparedDelegation) {
        return dispatchedResult;
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
        // A lost acknowledgement is not a rejected start. Do not delete a
        // worker whose accepted first turn may already be executing.
        yield* requireRejected(turnStartCommandId);
        const rollbackCommand = {
          type: "thread.delete",
          commandId: CommandId.make(yield* sources.randomUUID),
          threadId: workerThreadId,
        } as const satisfies OrchestrationCommand;
        const rollbackExit = yield* Effect.exit(engine.dispatch(rollbackCommand));
        // A failed thread deletion leaves ownership unresolved. Never remove
        // its checkout while that thread may still run or be retried.
        if (rollbackExit._tag === "Failure") return yield* failure("rollback-failed");
        const worktreeRollbackExit = yield* removeWorkerWorktree(turnStartCommandId);
        if (worktreeRollbackExit._tag === "Failure")
          return yield* Effect.failCause(worktreeRollbackExit.cause);
        return yield* failure("turn-start-failed", worktreeRollbackExit.value);
      }

      return dispatchedResult;
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
