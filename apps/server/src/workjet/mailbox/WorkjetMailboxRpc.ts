import {
  WorkjetMailboxError,
  type EnvironmentId,
  type ThreadId,
  type WorkjetMailboxDelegateTaskRpcInput,
  type WorkjetMailboxDelegateTaskRpcResult,
  type WorkjetMailboxReassignDelegationRpcInput,
  type WorkjetMailboxReassignDelegationRpcResult,
  type WorkjetMailboxReplyRpcInput,
  type WorkjetMailboxReplyRpcResult,
  type WorkjetMailboxRequestReviewRpcInput,
  type WorkjetMailboxRequestReviewRpcResult,
  type WorkjetMailboxSendMessageRpcInput,
  type WorkjetMailboxSendMessageRpcResult,
  type WorkjetMailboxUpdateDelegationRpcInput,
  type WorkjetMailboxUpdateDelegationRpcResult,
  type WorkjetMeshWorkspaceId,
  type WorkjetMessageBody,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationThread } from "@t3tools/contracts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { WorkjetDelegationExecutorShape } from "./WorkjetDelegationExecutor.ts";
import { boundMailboxStoreError } from "./WorkjetMailboxDelivery.ts";
import type { WorkjetMailboxDeliveryShape } from "./WorkjetMailboxDelivery.ts";
import type { WorkjetSnapshotStoreShape } from "./WorkjetSnapshotStore.ts";

/**
 * The WebSocket half of the Workjet mailbox (docs/workjet-plan.md → Wave 5
 * thread UI: "Add thread UI for 'Nachricht' versus 'Nachricht + Auftrag' …").
 *
 * Sending already existed server-side, but only behind the per-session MCP
 * credential, which no browser holds. This module is the client-facing
 * entrypoint and deliberately adds NO second implementation: it validates the
 * caller-named source thread, then hands the same inputs to the same
 * {@link WorkjetMailboxDeliveryShape} the MCP tools use.
 *
 * Authorization is the MCP decision restated for a different transport:
 *
 * - The transport-level scope (`orchestration:operate`) is checked by the RPC
 *   authorization table before a handler ever runs.
 * - The thread-level rule is checked here: the SOURCE thread must exist, must
 *   not be deleted, and must be an ORCHESTRATOR thread. Worker-initiated
 *   traffic (`workjet_reply`, delegation updates) and per-operation ACLs are
 *   separate, still-open plan items; widening the boundary here before those
 *   land would grant every thread cross-thread send rights with no ACL.
 *
 * A source thread that fails ANY part of that rule gets the single bounded
 * reason `unauthorized`. The three cases are deliberately not distinguished on
 * the wire: a client that may not send from a thread also may not learn from
 * the error whether that thread exists.
 */

/** Only the two reads this module performs, so tests can supply a double. */
export interface WorkjetMailboxRpcThreadQuery {
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;
}

export interface WorkjetMailboxRpcDependencies {
  readonly delivery: WorkjetMailboxDeliveryShape;
  readonly snapshots: WorkjetSnapshotStoreShape;
  readonly query: WorkjetMailboxRpcThreadQuery;
  /** This server's own mesh workspace id; substituted when the client omits one. */
  readonly workspaceId: WorkjetMeshWorkspaceId;
  /** This server's own environment id — the source environment, never caller-supplied. */
  readonly environmentId: EnvironmentId;
  /**
   * The delegation reconciler's reassignment port, in the executor's own shape
   * ({@link WorkjetDelegationExecutorShape.reassign}). It is injected rather
   * than resolved here so this module stays a pure handler factory; every
   * caller supplies the LIVE executor, which owns the foreign-environment guard
   * and the store write — the reassignment is never re-derived per entrypoint.
   */
  readonly reassign: WorkjetDelegationExecutorShape["reassign"];
}

export interface WorkjetMailboxRpcHandlers {
  readonly sendMessage: (
    input: WorkjetMailboxSendMessageRpcInput,
  ) => Effect.Effect<WorkjetMailboxSendMessageRpcResult, WorkjetMailboxError>;
  readonly delegateTask: (
    input: WorkjetMailboxDelegateTaskRpcInput,
  ) => Effect.Effect<WorkjetMailboxDelegateTaskRpcResult, WorkjetMailboxError>;
  readonly reply: (
    input: WorkjetMailboxReplyRpcInput,
  ) => Effect.Effect<WorkjetMailboxReplyRpcResult, WorkjetMailboxError>;
  readonly requestReview: (
    input: WorkjetMailboxRequestReviewRpcInput,
  ) => Effect.Effect<WorkjetMailboxRequestReviewRpcResult, WorkjetMailboxError>;
  readonly updateDelegation: (
    input: WorkjetMailboxUpdateDelegationRpcInput,
  ) => Effect.Effect<WorkjetMailboxUpdateDelegationRpcResult, WorkjetMailboxError>;
  readonly reassignDelegation: (
    input: WorkjetMailboxReassignDelegationRpcInput,
  ) => Effect.Effect<WorkjetMailboxReassignDelegationRpcResult, WorkjetMailboxError>;
}

const failure = (reason: WorkjetMailboxError["reason"]) => new WorkjetMailboxError({ reason });

/**
 * Snapshot failures collapse onto the mailbox contract's bounded reasons, the
 * same way the MCP tool maps them: the client learns that the prompt was too
 * large or that the mailbox could not accept it, never a path or a digest.
 */
const boundSnapshotError = (cause: { readonly _tag: string }): WorkjetMailboxError =>
  cause._tag === "WorkjetSnapshotTooLargeError"
    ? failure("payload-too-large")
    : failure("mailbox-unavailable");

export const makeWorkjetMailboxRpcHandlers = (
  dependencies: WorkjetMailboxRpcDependencies,
): WorkjetMailboxRpcHandlers => {
  const requireOrchestratorSource = (threadId: ThreadId) =>
    dependencies.query.getThreadDetailById(threadId).pipe(
      Effect.mapError(() => failure("mailbox-unavailable")),
      Effect.flatMap((option) =>
        Option.match(option, {
          onNone: () => Effect.fail(failure("unauthorized")),
          onSome: (thread) =>
            thread.deletedAt !== null || thread.workjetConfig.role !== "orchestrator"
              ? Effect.fail(failure("unauthorized"))
              : Effect.succeed({
                  environmentId: dependencies.environmentId,
                  threadId,
                } as const),
        }),
      ),
    );

  const normalizeBody = (body: WorkjetMessageBody): WorkjetMessageBody =>
    body._tag === "inline"
      ? { _tag: "inline", text: body.text }
      : { _tag: "sealed", payloadRef: body.payloadRef, byteLength: body.byteLength };

  const sendMessage: WorkjetMailboxRpcHandlers["sendMessage"] = Effect.fn(
    "WorkjetMailboxRpc.sendMessage",
  )(function* (input) {
    const sender = yield* requireOrchestratorSource(input.sourceThreadId);
    const body = normalizeBody(input.body);
    const outcome = yield* dependencies.delivery.sendMessage(sender, {
      targetWorkspaceId: input.targetWorkspaceId ?? dependencies.workspaceId,
      targetEnvironmentId: input.targetEnvironmentId,
      targetThreadId: input.targetThreadId,
      body,
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
      ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
    });
    return outcome._tag === "queued"
      ? ({ schemaVersion: 1, status: "queued", envelopeId: outcome.envelopeId } as const)
      : ({
          schemaVersion: 1,
          status: "acknowledged",
          envelopeId: outcome.envelopeId,
          disposition: outcome.receipt.disposition,
          acknowledgedAt: outcome.receipt.acknowledgedAt,
        } as const);
  });

  const delegateTask: WorkjetMailboxRpcHandlers["delegateTask"] = Effect.fn(
    "WorkjetMailboxRpc.delegateTask",
  )(function* (input) {
    const sender = yield* requireOrchestratorSource(input.sourceThreadId);
    // Written BEFORE the delegation, so the digest on the delegation always
    // describes bytes that already exist on disk.
    const snapshot = yield* dependencies.snapshots
      .put(input.prompt)
      .pipe(Effect.mapError(boundSnapshotError));
    const outcome = yield* dependencies.delivery.delegateTask(sender, {
      targetWorkspaceId: input.targetWorkspaceId ?? dependencies.workspaceId,
      targetEnvironmentId: input.targetEnvironmentId,
      targetThreadId: input.targetThreadId,
      prompt: {
        schemaVersion: 1,
        snapshotRef: snapshot.snapshotRef,
        digest: snapshot.digest,
        byteLength: snapshot.byteLength,
      },
      scope: { schemaVersion: 1, files: input.scope.files, nonGoals: input.scope.nonGoals },
      completion: { schemaVersion: 1, acceptance: input.acceptance },
      budget: {
        maxDepth: input.budget.maxDepth,
        maxReviewRounds: input.budget.maxReviewRounds,
        ttlSeconds: input.budget.ttlSeconds,
      },
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
      ...(input.parentDelegationId !== undefined
        ? { parentDelegationId: input.parentDelegationId }
        : {}),
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    });
    const base = {
      schemaVersion: 1,
      envelopeId: outcome.delivery.envelopeId,
      delegationId: outcome.delegation.delegationId,
      ownerEnvironmentId: outcome.delegation.owner.environmentId,
      ownerThreadId: outcome.delegation.owner.threadId,
      state: outcome.state,
    } as const;
    return outcome.delivery._tag === "queued"
      ? ({ ...base, status: "queued" } as const)
      : ({
          ...base,
          status: "acknowledged",
          disposition: outcome.delivery.receipt.disposition,
          acknowledgedAt: outcome.delivery.receipt.acknowledgedAt,
        } as const);
  });

  const reply: WorkjetMailboxRpcHandlers["reply"] = Effect.fn("WorkjetMailboxRpc.reply")(
    function* (input) {
      const sender = yield* requireOrchestratorSource(input.sourceThreadId);
      const outcome = yield* dependencies.delivery.reply(sender, {
        targetWorkspaceId: input.targetWorkspaceId ?? dependencies.workspaceId,
        targetEnvironmentId: input.targetEnvironmentId,
        targetThreadId: input.targetThreadId,
        delegationId: input.delegationId,
        body: normalizeBody(input.body),
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
      });
      return outcome._tag === "queued"
        ? ({ schemaVersion: 1, status: "queued", envelopeId: outcome.envelopeId } as const)
        : ({
            schemaVersion: 1,
            status: "acknowledged",
            envelopeId: outcome.envelopeId,
            disposition: outcome.receipt.disposition,
            acknowledgedAt: outcome.receipt.acknowledgedAt,
          } as const);
    },
  );

  const requestReview: WorkjetMailboxRpcHandlers["requestReview"] = Effect.fn(
    "WorkjetMailboxRpc.requestReview",
  )(function* (input) {
    const sender = yield* requireOrchestratorSource(input.sourceThreadId);
    const outcome = yield* dependencies.delivery.requestReview(sender, {
      targetWorkspaceId: input.targetWorkspaceId ?? dependencies.workspaceId,
      targetEnvironmentId: input.targetEnvironmentId,
      targetThreadId: input.targetThreadId,
      delegationId: input.delegationId,
      round: input.round,
      body: normalizeBody(input.body),
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    });
    const base = {
      schemaVersion: 1,
      envelopeId: outcome.delivery.envelopeId,
      delegationId: outcome.delegation.delegationId,
      state: outcome.state,
      edgeKind: outcome.edgeKind,
    } as const;
    return outcome.delivery._tag === "queued"
      ? ({ ...base, status: "queued" } as const)
      : ({
          ...base,
          status: "acknowledged",
          disposition: outcome.delivery.receipt.disposition,
          acknowledgedAt: outcome.delivery.receipt.acknowledgedAt,
        } as const);
  });

  const updateDelegation: WorkjetMailboxRpcHandlers["updateDelegation"] = Effect.fn(
    "WorkjetMailboxRpc.updateDelegation",
  )(function* (input) {
    // The source thread must still be an orchestrator thread, even though an
    // update carries no target address: it is the caller identity the delivery
    // service records as the actor of the transition.
    const actor = yield* requireOrchestratorSource(input.sourceThreadId);
    const outcome = yield* dependencies.delivery.updateDelegation(actor, {
      delegationId: input.delegationId,
      update:
        input.update._tag === "review"
          ? {
              _tag: "review",
              decision: input.update.decision,
              round: input.update.round,
              ...(input.update.reasons !== undefined ? { reasons: input.update.reasons } : {}),
            }
          : { _tag: input.update._tag },
    });
    return {
      schemaVersion: 1,
      delegationId: outcome.delegationId,
      state: outcome.state,
      ...(outcome.edgeKind !== undefined ? { edgeKind: outcome.edgeKind } : {}),
    } as const;
  });

  const reassignDelegation: WorkjetMailboxRpcHandlers["reassignDelegation"] = Effect.fn(
    "WorkjetMailboxRpc.reassignDelegation",
  )(function* (input) {
    // Same two-step authorization as an update: transport scope first, then the
    // caller-named SOURCE thread must still be a live orchestrator thread.
    yield* requireOrchestratorSource(input.sourceThreadId);
    // A thread on another machine is not a destination this server can run, and
    // saying so costs nothing a caller could not already infer from its own
    // environment id.
    if (input.targetEnvironmentId !== dependencies.environmentId) {
      return yield* failure("unknown-target");
    }
    const record = yield* dependencies
      .reassign({
        delegationId: input.delegationId,
        newTarget: {
          schemaVersion: 1,
          workspaceId: input.targetWorkspaceId ?? dependencies.workspaceId,
          environmentId: input.targetEnvironmentId,
          threadId: input.targetThreadId,
        },
      })
      .pipe(Effect.mapError(boundMailboxStoreError));
    return {
      schemaVersion: 1,
      delegationId: record.delegationId,
      state: record.state,
      targetEnvironmentId: record.delegation.target.environmentId,
      targetThreadId: record.delegation.target.threadId,
    } as const;
  });

  return { sendMessage, delegateTask, reply, requestReview, updateDelegation, reassignDelegation };
};
