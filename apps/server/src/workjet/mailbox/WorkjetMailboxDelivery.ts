import {
  CommandId,
  EventId,
  WorkjetDelegationId,
  WorkjetEnvelopeId,
  WorkjetMailboxError,
  type EnvironmentId,
  type OrchestrationCommand,
  type ThreadId,
  type WorkjetCompletionContract,
  type WorkjetDelegation,
  type WorkjetDelegationRef,
  type WorkjetDelegationScope,
  type WorkjetDelegationState,
  type WorkjetDeliveryDisposition,
  type WorkjetDeliveryReceipt,
  type WorkjetMailboxPayload,
  type WorkjetMailboxTimestamp,
  type WorkjetMeshWorkspaceId,
  type WorkjetMessageBody,
  type WorkjetPromptSnapshotRef,
  type WorkjetRoutingEnvelope,
  type WorkjetWorkerAddress,
  type WorkjetWorkerMessage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkjetMailboxStore, type WorkjetMailboxStoreError } from "./WorkjetMailboxStore.ts";
import { WorkjetMeshIdentity } from "./WorkjetMeshIdentity.ts";

/**
 * Same-environment Workjet mailbox delivery (docs/workjet-plan.md →
 * "Distributed worker mailbox and delegation graph").
 *
 * The plan states that "same-environment delivery may take a local fast path
 * but must obey the same contracts and state machine as remote delivery". This
 * service is that fast path and nothing else:
 *
 *   enqueueOutbound → recordInboundEnvelope → markDelivered
 *
 * Every outbound envelope is signed with this environment's key and every
 * inbound envelope is verified before it is accepted (see
 * {@link WorkjetMeshIdentity}); the source address is this environment's own
 * mesh identity, never a caller-supplied workspace id.
 *
 * every step through {@link WorkjetMailboxStore}, every value through the
 * `@t3tools/contracts` mailbox schemas, and the delegation lifecycle through
 * the store's enforced transition table (`queued → delivered`).
 *
 * A target in ANOTHER environment is enqueued as pending outbound and reported
 * as `queued`. Cross-machine transport (CTOX Sync WebRTC) is a later slice; the
 * durable record it will consume is written here already.
 */

// ===============================
// Bounds
// ===============================

/** Smallest envelope time-to-live a caller may request. */
export const WORKJET_MAILBOX_MIN_TTL_SECONDS = 60;

/** Largest envelope/delegation time-to-live a caller may request (7 days). */
export const WORKJET_MAILBOX_MAX_TTL_SECONDS = 604_800;

/** Default envelope time-to-live when the caller does not choose one. */
export const WORKJET_MAILBOX_DEFAULT_TTL_SECONDS = 3_600;

/** Thread-visible activity kinds appended for mailbox traffic. */
export const WORKJET_MESSAGE_SENT_ACTIVITY_KIND = "workjet.message.sent";
export const WORKJET_MESSAGE_RECEIVED_ACTIVITY_KIND = "workjet.message.received";
export const WORKJET_DELEGATION_SENT_ACTIVITY_KIND = "workjet.delegation.sent";
export const WORKJET_DELEGATION_RECEIVED_ACTIVITY_KIND = "workjet.delegation.received";

// ===============================
// Inputs and outcomes
// ===============================

/**
 * Only the TARGET workspace is caller-supplied. The source workspace id is this
 * environment's own mesh identity ({@link WorkjetMeshIdentity}) — a caller must
 * not be able to choose the workspace it claims to be sending from.
 */
export interface WorkjetMailboxSendMessageInput {
  readonly targetWorkspaceId: WorkjetMeshWorkspaceId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetThreadId: ThreadId;
  readonly body: WorkjetMessageBody;
  readonly ttlSeconds?: number;
  readonly inReplyTo?: WorkjetEnvelopeId;
}

export interface WorkjetMailboxDelegationBudgetInput {
  readonly maxDepth: number;
  readonly maxReviewRounds: number;
  readonly ttlSeconds: number;
}

export interface WorkjetMailboxDelegateInput {
  readonly targetWorkspaceId: WorkjetMeshWorkspaceId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetThreadId: ThreadId;
  readonly prompt: WorkjetPromptSnapshotRef;
  readonly scope: WorkjetDelegationScope;
  readonly completion: WorkjetCompletionContract;
  readonly budget: WorkjetMailboxDelegationBudgetInput;
  readonly depth?: number;
  /**
   * Id of the delegation this one continues. The owning ADDRESS is derived
   * here from the delegating thread's own mesh identity rather than accepted
   * from the caller, for the same reason the source workspace id is.
   */
  readonly parentDelegationId?: WorkjetDelegationId;
  readonly ttlSeconds?: number;
}

/**
 * `acknowledged` carries the target inbox's own {@link WorkjetDeliveryReceipt};
 * `queued` is the honest answer for a target this server cannot reach yet.
 */
export type WorkjetMailboxSendOutcome =
  | {
      readonly _tag: "acknowledged";
      readonly envelopeId: WorkjetEnvelopeId;
      readonly receipt: WorkjetDeliveryReceipt;
    }
  | { readonly _tag: "queued"; readonly envelopeId: WorkjetEnvelopeId };

export interface WorkjetMailboxDelegationOutcome {
  readonly delivery: WorkjetMailboxSendOutcome;
  readonly delegation: WorkjetDelegationRef;
  readonly state: WorkjetDelegationState;
}

export interface WorkjetMailboxDeliveryShape {
  readonly sendMessage: (
    invocation: McpInvocationScope,
    input: WorkjetMailboxSendMessageInput,
  ) => Effect.Effect<WorkjetMailboxSendOutcome, WorkjetMailboxError>;

  readonly delegateTask: (
    invocation: McpInvocationScope,
    input: WorkjetMailboxDelegateInput,
  ) => Effect.Effect<WorkjetMailboxDelegationOutcome, WorkjetMailboxError>;
}

export class WorkjetMailboxDelivery extends Context.Service<
  WorkjetMailboxDelivery,
  WorkjetMailboxDeliveryShape
>()("t3/workjet/mailbox/WorkjetMailboxDelivery") {}

export interface WorkjetMailboxDeliverySources {
  readonly randomUUID: Effect.Effect<string>;
  readonly nowIso: Effect.Effect<string>;
}

// ===============================
// Helpers
// ===============================

const failure = (reason: WorkjetMailboxError["reason"]) => new WorkjetMailboxError({ reason });

/**
 * Every store failure becomes a bounded mailbox reason. A SQL failure or a
 * corrupt row must never travel to a harness as a server message: the plan
 * forbids prompts, paths, and transport detail in anything a peer can read.
 */
const boundStoreError = (cause: WorkjetMailboxStoreError): WorkjetMailboxError =>
  cause._tag === "WorkjetMailboxError" ? cause : failure("mailbox-unavailable");

const clampTtlSeconds = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return WORKJET_MAILBOX_DEFAULT_TTL_SECONDS;
  const truncated = Math.trunc(value);
  if (truncated < WORKJET_MAILBOX_MIN_TTL_SECONDS) return WORKJET_MAILBOX_MIN_TTL_SECONDS;
  if (truncated > WORKJET_MAILBOX_MAX_TTL_SECONDS) return WORKJET_MAILBOX_MAX_TTL_SECONDS;
  return truncated;
};

const addSeconds = (
  iso: WorkjetMailboxTimestamp,
  seconds: number,
): Effect.Effect<WorkjetMailboxTimestamp, WorkjetMailboxError> =>
  Option.match(DateTime.make(iso), {
    onNone: () => Effect.fail(failure("malformed-envelope")),
    onSome: (instant) =>
      Effect.succeed(DateTime.formatIso(DateTime.addDuration(instant, Duration.seconds(seconds)))),
  });

/**
 * Redacted, bounded activity payload. Envelope/delegation ids, addresses, and
 * lifecycle state only — never the message text, never the sealed payload
 * reference, never prompt or artifact material.
 */
const activityPayload = (input: {
  readonly envelopeId: WorkjetEnvelopeId;
  readonly direction: "outbound" | "inbound";
  readonly source: WorkjetWorkerAddress;
  readonly target: WorkjetWorkerAddress;
  readonly bodyKind?: WorkjetMessageBody["_tag"];
  readonly disposition?: WorkjetDeliveryDisposition;
  readonly delegationId?: WorkjetDelegationId;
  readonly delegationState?: WorkjetDelegationState;
  readonly createdAt: WorkjetMailboxTimestamp;
  readonly expiresAt: WorkjetMailboxTimestamp;
}) => ({
  schemaVersion: 1 as const,
  envelopeId: input.envelopeId,
  direction: input.direction,
  source: {
    workspaceId: input.source.workspaceId,
    environmentId: input.source.environmentId,
    threadId: input.source.threadId,
  },
  target: {
    workspaceId: input.target.workspaceId,
    environmentId: input.target.environmentId,
    threadId: input.target.threadId,
  },
  ...(input.bodyKind !== undefined ? { bodyKind: input.bodyKind } : {}),
  ...(input.disposition !== undefined ? { disposition: input.disposition } : {}),
  ...(input.delegationId !== undefined ? { delegationId: input.delegationId } : {}),
  ...(input.delegationState !== undefined ? { delegationState: input.delegationState } : {}),
  createdAt: input.createdAt,
  expiresAt: input.expiresAt,
});

export const makeWorkjetMailboxDeliveryWithSources = Effect.fn(
  "WorkjetMailboxDelivery.makeWithSources",
)(function* (sources: WorkjetMailboxDeliverySources) {
  const store = yield* WorkjetMailboxStore;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const identity = yield* WorkjetMeshIdentity;

  const envelopeId = sources.randomUUID.pipe(
    Effect.map((uuid) => WorkjetEnvelopeId.make(`wjm-${uuid}`)),
  );
  const delegationIdEffect = sources.randomUUID.pipe(
    Effect.map((uuid) => WorkjetDelegationId.make(`wjd-${uuid}`)),
  );
  const commandId = (tag: string) =>
    sources.randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const activityId = sources.randomUUID.pipe(Effect.map(EventId.make));

  /**
   * Thread-visible durable trace. The mailbox store is authoritative for
   * delivery, so a rejected activity append must not turn a delivered envelope
   * into a reported failure; the append is therefore best-effort and its
   * failure is swallowed rather than surfaced as a mailbox error.
   */
  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly createdAt: WorkjetMailboxTimestamp;
  }) =>
    Effect.gen(function* () {
      const command = {
        type: "thread.activity.append",
        commandId: yield* commandId("workjet-mailbox-activity"),
        threadId: input.threadId,
        activity: {
          id: yield* activityId,
          tone: "info",
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      } as const satisfies OrchestrationCommand;
      yield* engine.dispatch(command);
    }).pipe(Effect.ignore);

  /**
   * A same-environment target must exist and must not be deleted. Checking
   * BEFORE the durable write keeps `unknown-target` / `target-thread-deleted`
   * exact and guarantees the target-side activity has a thread to land on.
   */
  const requireLocalTargetThread = (threadId: ThreadId) =>
    query.getThreadDetailById(threadId).pipe(
      Effect.mapError(() => failure("mailbox-unavailable")),
      Effect.flatMap((option) =>
        Option.match(option, {
          onNone: () => Effect.fail(failure("unknown-target")),
          onSome: (thread) =>
            thread.deletedAt !== null
              ? Effect.fail(failure("target-thread-deleted"))
              : Effect.succeed(thread),
        }),
      ),
    );

  /**
   * Builds the immutable routing envelope and signs its canonical
   * serialization with THIS environment's key. The signature is produced once,
   * before the durable outbox write, so the row a future transport picks up is
   * already the exact bytes a peer will verify.
   */
  const routingEnvelope = (input: {
    readonly envelopeId: WorkjetEnvelopeId;
    readonly kind: WorkjetRoutingEnvelope["kind"];
    readonly source: WorkjetWorkerAddress;
    readonly target: WorkjetWorkerAddress;
    readonly createdAt: WorkjetMailboxTimestamp;
    readonly expiresAt: WorkjetMailboxTimestamp;
  }): Effect.Effect<WorkjetRoutingEnvelope, WorkjetMailboxError> =>
    identity.signRoutingEnvelope({
      schemaVersion: 1,
      envelopeId: input.envelopeId,
      kind: input.kind,
      sourceWorkspaceId: input.source.workspaceId,
      sourceEnvironmentId: input.source.environmentId,
      targetWorkspaceId: input.target.workspaceId,
      targetEnvironmentId: input.target.environmentId,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    });

  /**
   * The shared local fast path. It runs the SAME three store operations for a
   * message and for a delegation, so both obey one state machine; the caller
   * only supplies what to do when the target inbox accepted a NEW envelope.
   */
  const deliverLocally = (input: {
    readonly envelope: WorkjetRoutingEnvelope;
    readonly payload: WorkjetMailboxPayload;
    readonly target: WorkjetWorkerAddress;
    readonly now: WorkjetMailboxTimestamp;
    readonly onAcceptedNew: (
      disposition: WorkjetDeliveryDisposition,
    ) => Effect.Effect<void, WorkjetMailboxError>;
  }) =>
    Effect.gen(function* () {
      // The receiving side verifies BEFORE it accepts anything durable, even
      // on the local fast path: the plan requires the same contracts and state
      // machine as remote delivery, so an unverifiable envelope must never
      // reach an inbox — not even one this process signed a moment ago.
      const verified = yield* identity.verifyRoutingEnvelope(input.envelope);
      if (!verified) {
        return yield* failure("invalid-signature");
      }

      const inbound = yield* store
        .recordInboundEnvelope(input.envelope, input.payload, input.now)
        .pipe(Effect.mapError(boundStoreError));

      const disposition: WorkjetDeliveryDisposition = inbound._tag;

      if (inbound._tag === "accepted-new") {
        yield* store
          .markDelivered(input.envelope.envelopeId, input.now)
          .pipe(Effect.mapError(boundStoreError));
        yield* input.onAcceptedNew(disposition);
      }

      const receipt: WorkjetDeliveryReceipt = {
        schemaVersion: 1,
        envelopeId: input.envelope.envelopeId,
        acknowledgedBy: input.target,
        acknowledgedAt: input.now,
        disposition,
      };
      return {
        _tag: "acknowledged",
        envelopeId: input.envelope.envelopeId,
        receipt,
      } as const satisfies WorkjetMailboxSendOutcome;
    });

  const resolveAddresses = (
    invocation: McpInvocationScope,
    input: {
      readonly targetWorkspaceId: WorkjetMeshWorkspaceId;
      readonly targetEnvironmentId: EnvironmentId;
      readonly targetThreadId: ThreadId;
    },
  ) => {
    const source: WorkjetWorkerAddress = {
      schemaVersion: 1,
      workspaceId: identity.workspaceId,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
    };
    const target: WorkjetWorkerAddress = {
      schemaVersion: 1,
      workspaceId: input.targetWorkspaceId,
      environmentId: input.targetEnvironmentId,
      threadId: input.targetThreadId,
    };
    return {
      source,
      target,
      sameEnvironment: source.environmentId === target.environmentId,
    } as const;
  };

  const sendMessage: WorkjetMailboxDeliveryShape["sendMessage"] = Effect.fn(
    "WorkjetMailboxDelivery.sendMessage",
  )(function* (invocation, input) {
    const { source, target, sameEnvironment } = resolveAddresses(invocation, input);

    // The contract reserves `inline` for the local fast path: an inline body
    // must never be produced for a target in a different environment, because
    // only a sealed reference may leave this machine.
    if (!sameEnvironment && input.body._tag === "inline") {
      return yield* failure("malformed-envelope");
    }

    if (sameEnvironment) {
      yield* requireLocalTargetThread(target.threadId);
    }

    const now = yield* sources.nowIso;
    const expiresAt = yield* addSeconds(now, clampTtlSeconds(input.ttlSeconds));
    const id = yield* envelopeId;

    const message: WorkjetWorkerMessage = {
      schemaVersion: 1,
      envelopeId: id,
      source,
      target,
      createdAt: now,
      expiresAt,
      body: input.body,
      ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
    };
    const payload = { _tag: "message", message } as const satisfies WorkjetMailboxPayload;
    const envelope = yield* routingEnvelope({
      envelopeId: id,
      kind: "message",
      source,
      target,
      createdAt: now,
      expiresAt,
    });

    const enqueued = yield* store
      .enqueueOutbound(envelope, payload)
      .pipe(Effect.mapError(boundStoreError));

    yield* appendActivity({
      threadId: source.threadId,
      kind: WORKJET_MESSAGE_SENT_ACTIVITY_KIND,
      summary: sameEnvironment ? "Workjet message sent" : "Workjet message queued",
      payload: activityPayload({
        envelopeId: id,
        direction: "outbound",
        source,
        target,
        bodyKind: input.body._tag,
        createdAt: now,
        expiresAt,
      }),
      createdAt: now,
    });

    if (!sameEnvironment) {
      return { _tag: "queued", envelopeId: id } as const;
    }

    return yield* deliverLocally({
      envelope,
      payload,
      target,
      now,
      // A duplicate replay reaches neither this callback nor the target
      // thread, so at-least-once transport still produces exactly one
      // thread-visible inbound activity.
      onAcceptedNew: (disposition) =>
        enqueued._tag === "duplicate" || target.threadId === source.threadId
          ? Effect.void
          : appendActivity({
              threadId: target.threadId,
              kind: WORKJET_MESSAGE_RECEIVED_ACTIVITY_KIND,
              summary: "Workjet message received",
              payload: activityPayload({
                envelopeId: id,
                direction: "inbound",
                source,
                target,
                bodyKind: input.body._tag,
                disposition,
                createdAt: now,
                expiresAt,
              }),
              createdAt: now,
            }),
    });
  });

  const delegateTask: WorkjetMailboxDeliveryShape["delegateTask"] = Effect.fn(
    "WorkjetMailboxDelivery.delegateTask",
  )(function* (invocation, input) {
    const { source, target, sameEnvironment } = resolveAddresses(invocation, input);

    if (sameEnvironment) {
      yield* requireLocalTargetThread(target.threadId);
    }

    const now = yield* sources.nowIso;
    const expiresAt = yield* addSeconds(now, clampTtlSeconds(input.ttlSeconds));
    const budgetExpiresAt = yield* addSeconds(now, clampTtlSeconds(input.budget.ttlSeconds));
    const id = yield* envelopeId;
    const delegationId = yield* delegationIdEffect;

    const delegation: WorkjetDelegation = {
      schemaVersion: 1,
      envelopeId: id,
      delegationId,
      source,
      target,
      createdAt: now,
      expiresAt,
      prompt: input.prompt,
      scope: input.scope,
      completion: input.completion,
      budget: {
        schemaVersion: 1,
        maxDepth: input.budget.maxDepth,
        maxReviewRounds: input.budget.maxReviewRounds,
        expiresAt: budgetExpiresAt,
      },
      state: "queued",
      stateChangedAt: now,
      depth: input.depth ?? 0,
      ...(input.parentDelegationId !== undefined
        ? {
            parent: {
              schemaVersion: 1,
              delegationId: input.parentDelegationId,
              owner: source,
            } as const satisfies WorkjetDelegationRef,
          }
        : {}),
    };

    if (delegation.depth > delegation.budget.maxDepth) {
      return yield* failure("depth-exceeded");
    }

    const payload = { _tag: "delegation", delegation } as const satisfies WorkjetMailboxPayload;
    const envelope = yield* routingEnvelope({
      envelopeId: id,
      kind: "delegation",
      source,
      target,
      createdAt: now,
      expiresAt,
    });
    const ref: WorkjetDelegationRef = {
      schemaVersion: 1,
      delegationId,
      owner: target,
    };

    const enqueued = yield* store
      .enqueueOutbound(envelope, payload)
      .pipe(Effect.mapError(boundStoreError));

    // A duplicate envelope means the delegation row already exists and may
    // already have moved on; re-upserting `queued` over it would be refused by
    // the store, so the replay simply skips both writes.
    if (enqueued._tag === "enqueued") {
      yield* store.upsertDelegation(delegation).pipe(Effect.mapError(boundStoreError));
    }

    yield* appendActivity({
      threadId: source.threadId,
      kind: WORKJET_DELEGATION_SENT_ACTIVITY_KIND,
      summary: sameEnvironment ? "Workjet delegation sent" : "Workjet delegation queued",
      payload: activityPayload({
        envelopeId: id,
        direction: "outbound",
        source,
        target,
        delegationId,
        delegationState: "queued",
        createdAt: now,
        expiresAt,
      }),
      createdAt: now,
    });

    if (!sameEnvironment) {
      return {
        delivery: { _tag: "queued", envelopeId: id } as const,
        delegation: ref,
        state: "queued",
      } as const satisfies WorkjetMailboxDelegationOutcome;
    }

    const delivery = yield* deliverLocally({
      envelope,
      payload,
      target,
      now,
      onAcceptedNew: () => Effect.void,
    });

    // A duplicate replay must not re-run the lifecycle: delivery is
    // at-least-once, delegation effects are exactly-once by deduplication.
    const advances =
      enqueued._tag === "enqueued" &&
      delivery._tag === "acknowledged" &&
      delivery.receipt.disposition === "accepted-new";
    if (!advances) {
      return {
        delivery,
        delegation: ref,
        state: "queued",
      } as const satisfies WorkjetMailboxDelegationOutcome;
    }

    // The lifecycle advances through the store's enforced transition table,
    // never by rewriting the delegation row directly.
    const record = yield* store
      .transitionDelegationState(delegationId, "queued", "delivered", now)
      .pipe(Effect.mapError(boundStoreError));

    if (target.threadId !== source.threadId) {
      yield* appendActivity({
        threadId: target.threadId,
        kind: WORKJET_DELEGATION_RECEIVED_ACTIVITY_KIND,
        summary: "Workjet delegation received",
        payload: activityPayload({
          envelopeId: id,
          direction: "inbound",
          source,
          target,
          disposition: "accepted-new",
          delegationId,
          delegationState: record.state,
          createdAt: now,
          expiresAt,
        }),
        createdAt: now,
      });
    }

    return {
      delivery,
      delegation: ref,
      state: record.state,
    } as const satisfies WorkjetMailboxDelegationOutcome;
  });

  return WorkjetMailboxDelivery.of({ sendMessage, delegateTask });
});

export const makeWorkjetMailboxDelivery = Effect.fn("WorkjetMailboxDelivery.make")(function* () {
  const crypto = yield* Crypto.Crypto;
  return yield* makeWorkjetMailboxDeliveryWithSources({
    randomUUID: crypto.randomUUIDv4.pipe(Effect.orDie),
    nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
  });
});

export const layer = Layer.effect(WorkjetMailboxDelivery, makeWorkjetMailboxDelivery());
