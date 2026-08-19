import {
  WorkjetMailboxError,
  type EnvironmentId,
  type ThreadId,
  type WorkjetMailboxDelegateTaskRpcInput,
  type WorkjetMailboxDelegateTaskRpcResult,
  type WorkjetMailboxSendMessageRpcInput,
  type WorkjetMailboxSendMessageRpcResult,
  type WorkjetMeshWorkspaceId,
  type WorkjetMessageBody,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationThread } from "@t3tools/contracts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
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
}

export interface WorkjetMailboxRpcHandlers {
  readonly sendMessage: (
    input: WorkjetMailboxSendMessageRpcInput,
  ) => Effect.Effect<WorkjetMailboxSendMessageRpcResult, WorkjetMailboxError>;
  readonly delegateTask: (
    input: WorkjetMailboxDelegateTaskRpcInput,
  ) => Effect.Effect<WorkjetMailboxDelegateTaskRpcResult, WorkjetMailboxError>;
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

  const sendMessage: WorkjetMailboxRpcHandlers["sendMessage"] = Effect.fn(
    "WorkjetMailboxRpc.sendMessage",
  )(function* (input) {
    const sender = yield* requireOrchestratorSource(input.sourceThreadId);
    const body: WorkjetMessageBody =
      input.body._tag === "inline"
        ? { _tag: "inline", text: input.body.text }
        : { _tag: "sealed", payloadRef: input.body.payloadRef, byteLength: input.body.byteLength };
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

  return { sendMessage, delegateTask };
};
