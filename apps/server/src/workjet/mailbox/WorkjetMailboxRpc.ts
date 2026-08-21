import {
  WorkjetGitBranchName,
  WorkjetMailboxError,
  WORKJET_HANDOFF_LIST_MAX,
  type WorkjetDelegationId,
  type EnvironmentId,
  type ThreadId,
  type WorkjetHandoffBranchRef,
  type WorkjetMailboxAcceptHandoffRpcInput,
  type WorkjetMailboxAcceptHandoffRpcResult,
  type WorkjetMailboxListHandoffsRpcInput,
  type WorkjetMailboxListHandoffsRpcResult,
  type WorkjetMailboxSendHandoffRpcInput,
  type WorkjetMailboxSendHandoffRpcResult,
  type WorkjetReceivedHandoff,
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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { OrchestrationThread } from "@t3tools/contracts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { WorkjetDelegationExecutorShape } from "./WorkjetDelegationExecutor.ts";
import { boundMailboxStoreError } from "./WorkjetMailboxDelivery.ts";
import type { WorkjetMailboxDeliveryShape } from "./WorkjetMailboxDelivery.ts";
import { snapshotDigestForRef } from "./WorkjetSnapshotStore.ts";
import type { WorkjetSnapshotStoreShape } from "./WorkjetSnapshotStore.ts";
import { composeWorkjetHandoffSnapshot } from "./WorkjetHandoffSnapshot.ts";

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
  /**
   * The clock, injected rather than read here so the composed snapshot — which
   * is content-addressed and therefore digest-sensitive to every byte — is
   * deterministic under test.
   */
  readonly nowIso: Effect.Effect<string>;
  /**
   * Does the SOURCE thread's repository have a primary remote configured?
   *
   * It is a port rather than a Git call in this module for two reasons: this
   * file is a pure handler factory with no service dependencies, and the answer
   * must stay a LOCAL configuration read. It never resolves whether a commit is
   * reachable on that remote — that needs `git ls-remote`, a network call a
   * handoff must not make — and it never pushes. A caller that cannot answer
   * returns `false`, which understates rather than overstates reachability.
   */
  readonly sourceRemoteConfigured: (threadId: ThreadId) => Effect.Effect<boolean>;
  /**
   * The TARGET thread of a delegation, or `None` when it is unknown here.
   *
   * Used for exactly one thing: deciding whether a WORKER caller is acting on
   * its OWN delegation. Opening these operations to workers without it would
   * let any worker thread reply to, review, or transition ANY delegation on
   * this machine, which is a strictly larger authority than the orchestrator
   * gate it replaces. `None` therefore denies rather than allows.
   *
   * A port, like every other dependency here, so this file stays a pure
   * handler factory with no service of its own.
   */
  readonly delegationTargetThreadId: (
    delegationId: WorkjetDelegationId,
  ) => Effect.Effect<Option.Option<ThreadId>>;
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
  readonly sendHandoff: (
    input: WorkjetMailboxSendHandoffRpcInput,
  ) => Effect.Effect<WorkjetMailboxSendHandoffRpcResult, WorkjetMailboxError>;
  readonly listHandoffs: (
    input: WorkjetMailboxListHandoffsRpcInput,
  ) => Effect.Effect<WorkjetMailboxListHandoffsRpcResult, WorkjetMailboxError>;
  readonly acceptHandoff: (
    input: WorkjetMailboxAcceptHandoffRpcInput,
  ) => Effect.Effect<WorkjetMailboxAcceptHandoffRpcResult, WorkjetMailboxError>;
}

const failure = (reason: WorkjetMailboxError["reason"]) => new WorkjetMailboxError({ reason });

/**
 * A projection's branch string is free text; the contract's branch name is not.
 * A branch this schema refuses is omitted from the handoff rather than coerced,
 * because a malformed name on the wire would be a claim about a ref that does
 * not exist.
 */
const isGitBranchName = Schema.is(WorkjetGitBranchName);

/** Epoch millis from a durable row back to the contract's ISO timestamp. */
const isoOfMillis = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));

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
  /**
   * Per-operation authorization, replacing a single orchestrator-only gate.
   *
   * Two roles can act, and they can act on DIFFERENT things:
   *
   *  - an orchestrator may address any delegation it owns the conversation
   *    for, which is what it always could;
   *  - a worker may act ONLY on the delegation whose target thread it is.
   *
   * That ownership check is the whole reason this is not just a widened role
   * list. Letting workers call these operations without it would grant every
   * worker thread authority over every delegation on the machine — a strictly
   * larger power than the gate being replaced, in the name of making it
   * finer-grained.
   */
  const requireSource = (input: {
    readonly threadId: ThreadId;
    readonly allow: ReadonlyArray<"orchestrator" | "worker">;
  }) =>
    dependencies.query.getThreadDetailById(input.threadId).pipe(
      Effect.mapError(() => failure("mailbox-unavailable")),
      Effect.flatMap((option) =>
        Option.match(option, {
          onNone: () => Effect.fail(failure("unauthorized")),
          onSome: (thread) => {
            const role = thread.workjetConfig.role;
            return thread.deletedAt !== null ||
              (role !== "orchestrator" && role !== "worker") ||
              !input.allow.includes(role)
              ? Effect.fail(failure("unauthorized"))
              : Effect.succeed({
                  environmentId: dependencies.environmentId,
                  threadId: input.threadId,
                  role,
                } as const);
          },
        }),
      ),
    );

  const requireOrchestratorSource = (threadId: ThreadId) =>
    requireSource({ threadId, allow: ["orchestrator"] }).pipe(
      Effect.map(({ environmentId, threadId: id }) => ({ environmentId, threadId: id }) as const),
    );

  /**
   * Orchestrator, or the worker that OWNS this delegation. An unknown
   * delegation denies: the alternative is letting a worker probe for, or act
   * on, delegations this machine cannot vouch for.
   */
  const requireDelegationParticipant = (input: {
    readonly threadId: ThreadId;
    readonly delegationId: WorkjetDelegationId;
  }) =>
    Effect.gen(function* () {
      const source = yield* requireSource({
        threadId: input.threadId,
        allow: ["orchestrator", "worker"],
      });
      if (source.role === "orchestrator") {
        return { environmentId: source.environmentId, threadId: source.threadId } as const;
      }
      const target = yield* dependencies
        .delegationTargetThreadId(input.delegationId)
        .pipe(Effect.catchCause(() => Effect.succeed(Option.none<ThreadId>())));
      if (Option.isNone(target) || target.value !== input.threadId) {
        return yield* Effect.fail(failure("unauthorized"));
      }
      return { environmentId: source.environmentId, threadId: source.threadId } as const;
    });

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
      // A worker replying on its OWN delegation is the point of this path:
      // until now a worker could not use the mailbox at all, so the only way
      // to answer an orchestrator was out of band.
      const sender = yield* requireDelegationParticipant({
        threadId: input.sourceThreadId,
        delegationId: input.delegationId,
      });
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
    // The worker asks for review of the work it just did; that is the natural
    // direction of this operation, and it was previously impossible.
    const sender = yield* requireDelegationParticipant({
      threadId: input.sourceThreadId,
      delegationId: input.delegationId,
    });
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
    // The caller identity the delivery service records as the actor of the
    // transition. An update carries no target address, so the delegation id is
    // the only thing tying a worker to what it may touch — which is exactly
    // what the participant check reads.
    const actor = yield* requireDelegationParticipant({
      threadId: input.sourceThreadId,
      delegationId: input.delegationId,
    });
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
    // ORCHESTRATOR ONLY, deliberately, unlike reply/requestReview/update.
    // Reassignment moves a delegation to a different target; a worker doing
    // that to its own delegation would be handing away work it was given,
    // which is an orchestration decision and not the worker's to make.
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

  // -----------------------------
  // Typed thread handoff
  // -----------------------------

  /**
   * The Git branch a handoff reports, derived ONLY from what this server can
   * state offline.
   *
   * The thread projection knows the branch NAME. It does not know the branch
   * head, and resolving one would need a `git rev-parse` the Git service does
   * not expose; the contract therefore leaves `headCommit` optional and this
   * function omits it rather than substituting a stale or unrelated hash.
   * `remoteConfigured` answers only "does the source repository have a primary
   * remote", which is a local configuration read — never `git ls-remote`, never
   * a push, and never a claim that the branch is reachable there.
   */
  const handoffBranchOf = (input: {
    readonly branch: string | null;
    readonly remoteConfigured: boolean;
  }): WorkjetHandoffBranchRef | undefined => {
    const name = input.branch?.trim();
    if (name === undefined || name.length === 0) return undefined;
    if (!isGitBranchName(name)) return undefined;
    return {
      schemaVersion: 1,
      branch: WorkjetGitBranchName.make(name),
      remoteConfigured: input.remoteConfigured,
    };
  };

  const sendHandoff: WorkjetMailboxRpcHandlers["sendHandoff"] = Effect.fn(
    "WorkjetMailboxRpc.sendHandoff",
  )(function* (input) {
    const sender = yield* requireOrchestratorSource(input.sourceThreadId);
    // Re-read the full detail: the composition needs the title and the message
    // tail, and `requireOrchestratorSource` deliberately returns only the
    // address it validated.
    const thread = yield* dependencies.query.getThreadDetailById(input.sourceThreadId).pipe(
      Effect.mapError(() => failure("mailbox-unavailable")),
      Effect.flatMap((option) =>
        Option.match(option, {
          onNone: () => Effect.fail(failure("unauthorized")),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const now = yield* dependencies.nowIso;
    const targetWorkspaceId = input.targetWorkspaceId ?? dependencies.workspaceId;
    const branch = handoffBranchOf({
      branch: thread.branch,
      remoteConfigured: yield* dependencies.sourceRemoteConfigured(input.sourceThreadId),
    });

    const composition = composeWorkjetHandoffSnapshot({
      sourceThread: {
        schemaVersion: 1,
        workspaceId: dependencies.workspaceId,
        environmentId: sender.environmentId,
        threadId: sender.threadId,
      },
      targetEnvironmentId: input.targetEnvironmentId,
      title: thread.title,
      branch,
      note: input.note,
      composedAt: now,
      messages: thread.messages.map((message) => ({
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      })),
    });

    // Written BEFORE the handoff, exactly like a delegation prompt: the digest
    // on the wire always describes bytes that already exist on disk, and no
    // caller-supplied digest is ever accepted.
    const snapshot = yield* dependencies.snapshots
      .put(composition.text)
      .pipe(Effect.mapError(boundSnapshotError));

    const outcome = yield* dependencies.delivery.sendHandoff(sender, {
      targetWorkspaceId,
      targetEnvironmentId: input.targetEnvironmentId,
      contextSnapshot: {
        schemaVersion: 1,
        snapshotRef: snapshot.snapshotRef,
        digest: snapshot.digest,
        byteLength: snapshot.byteLength,
      },
      ...(branch !== undefined ? { branch } : {}),
      // Bounded references only. The branch travels in its own field; commit
      // hashes and repository paths are not knowable offline here, so the
      // arrays are honestly empty rather than speculatively filled.
      artifacts: { schemaVersion: 1, commitHashes: [], paths: [] },
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    });

    const base = {
      schemaVersion: 1,
      envelopeId: outcome.delivery.envelopeId,
      handoffId: outcome.handoffId,
      snapshotByteLength: snapshot.byteLength,
    } as const;
    return outcome.delivery._tag === "queued"
      ? ({ ...base, status: "queued" } as const)
      : ({
          ...base,
          status: "acknowledged",
          disposition: outcome.delivery.disposition,
          acknowledgedAt: outcome.delivery.acknowledgedAt,
        } as const);
  });

  /**
   * Is this handoff's context readable HERE? The answer is the snapshot store's,
   * taken from the directory entry alone — the bytes are never read to answer a
   * listing, and a store fault is reported as "not available" rather than
   * failing the whole inbox read: one unreadable handoff must not hide the rest.
   */
  const snapshotAvailability = (record: {
    readonly handoff: { readonly contextSnapshot: { readonly snapshotRef: string } };
  }) =>
    Option.match(snapshotDigestForRef(record.handoff.contextSnapshot.snapshotRef), {
      onNone: () => Effect.succeed(false),
      onSome: (digest) =>
        dependencies.snapshots.stat(digest).pipe(
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
        ),
    });

  const listHandoffs: WorkjetMailboxRpcHandlers["listHandoffs"] = Effect.fn(
    "WorkjetMailboxRpc.listHandoffs",
  )(function* (input) {
    const limit = input.limit ?? WORKJET_HANDOFF_LIST_MAX;
    const records = yield* dependencies.delivery.listReceivedHandoffs(limit);
    const handoffs = yield* Effect.forEach(records, (record) =>
      Effect.map(snapshotAvailability(record), (snapshotAvailable) => {
        const handoff = record.handoff;
        return {
          schemaVersion: 1,
          handoffId: handoff.handoffId,
          envelopeId: handoff.envelopeId,
          sourceThread: handoff.sourceThread,
          createdAt: handoff.createdAt,
          expiresAt: handoff.expiresAt,
          receivedAt: isoOfMillis(record.receivedAtMillis),
          snapshotAvailable,
          snapshotByteLength: handoff.contextSnapshot.byteLength,
          ...(handoff.branch !== undefined ? { branch: handoff.branch } : {}),
          ...(handoff.note !== undefined ? { note: handoff.note } : {}),
          ...(record.acceptedThreadId !== null
            ? { acceptedThreadId: record.acceptedThreadId }
            : {}),
          ...(record.acceptedAtMillis !== null
            ? { acceptedAt: isoOfMillis(record.acceptedAtMillis) }
            : {}),
        } as WorkjetReceivedHandoff;
      }),
    );
    return { schemaVersion: 1, handoffs } as const;
  });

  const acceptHandoff: WorkjetMailboxRpcHandlers["acceptHandoff"] = Effect.fn(
    "WorkjetMailboxRpc.acceptHandoff",
  )(function* (input) {
    const record = yield* dependencies.delivery.getReceivedHandoff(input.handoffId);
    const handoffRecord = yield* Option.match(record, {
      onNone: () => Effect.fail(failure("unknown-target")),
      onSome: (value) => Effect.succeed(value),
    });

    // The snapshot is resolved BEFORE any durable effect: a handoff whose
    // context never arrived must be refused with its own bounded reason, not
    // continued into a thread seeded with nothing.
    const digest = snapshotDigestForRef(handoffRecord.handoff.contextSnapshot.snapshotRef);
    const snapshotText = yield* Option.match(digest, {
      onNone: () => Effect.fail(failure("handoff-snapshot-unavailable")),
      onSome: (value) =>
        dependencies.snapshots
          .get(value)
          .pipe(Effect.mapError(() => failure("handoff-snapshot-unavailable"))),
    });

    const outcome = yield* dependencies.delivery.acceptHandoff({
      handoffId: input.handoffId,
      hostThreadId: input.hostThreadId,
      snapshotText,
    });
    return {
      schemaVersion: 1,
      handoffId: outcome.handoffId,
      threadId: outcome.threadId,
      acceptedAt: outcome.acceptedAt,
    } as const;
  });

  return {
    sendMessage,
    delegateTask,
    reply,
    requestReview,
    updateDelegation,
    reassignDelegation,
    sendHandoff,
    listHandoffs,
    acceptHandoff,
  };
};
