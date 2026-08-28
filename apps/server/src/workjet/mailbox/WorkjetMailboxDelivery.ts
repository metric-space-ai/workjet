import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  WorkjetDelegationId,
  WorkjetEnvelopeId,
  WorkjetHandoffId,
  WorkjetMailboxError,
  type EnvironmentId,
  type OrchestrationCommand,
  type WorkjetCompletionContract,
  type WorkjetDelegation,
  type WorkjetDelegationEdge,
  type WorkjetDelegationEdgeKind,
  type WorkjetDelegationRef,
  type WorkjetDelegationScope,
  type WorkjetDelegationState,
  type WorkjetReviewDecision,
  type WorkjetDeliveryDisposition,
  type WorkjetDeliveryReceipt,
  type WorkjetMailboxPayload,
  type WorkjetMailboxTimestamp,
  type WorkjetMeshWorkspaceId,
  type WorkjetMessageBody,
  type WorkjetArtifactReferences,
  type WorkjetHandoffBranchRef,
  type WorkjetPromptSnapshotRef,
  type WorkjetRoutingEnvelope,
  type WorkjetThreadHandoff,
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

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WorkjetMailboxStore,
  type WorkjetDelegationRecord,
  type WorkjetReceivedHandoffRecord,
  type WorkjetMailboxStoreError,
  type WorkjetMailboxStoreShape,
} from "./WorkjetMailboxStore.ts";
import {
  WorkjetMailboxAuditEmitter,
  emitAudit,
  type WorkjetMailboxAuditSink,
} from "./WorkjetMailboxAuditEmitter.ts";
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
export const WORKJET_HANDOFF_SENT_ACTIVITY_KIND = "workjet.handoff.sent";
export const WORKJET_HANDOFF_ACCEPTED_ACTIVITY_KIND = "workjet.handoff.accepted";

// ===============================
// Inputs and outcomes
// ===============================

/**
 * Who is sending. Only the two address fields are read here, so an MCP
 * invocation scope satisfies it structurally and the WebSocket RPC path can
 * supply the same pair (server environment + validated source thread) without
 * inventing a fake provider session. Widening the parameter rather than
 * duplicating the service keeps ONE source-address derivation.
 */
export interface WorkjetMailboxSenderScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

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
  /**
   * Set when this message belongs to a delegation thread (a `workjet_reply` or
   * the `workjet_request_review` signal). It only decorates the redacted
   * thread-activity payload — the wire message carries the delegation link via
   * {@link WorkjetMailboxSendMessageInput.inReplyTo}, never a delegation id.
   */
  readonly delegationId?: WorkjetDelegationId;
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

/**
 * A plain informational reply on an existing delegation thread. It carries no
 * task; the target address is caller-supplied exactly like a message, plus the
 * delegation whose envelope the reply references.
 */
export interface WorkjetMailboxReplyInput {
  readonly targetWorkspaceId: WorkjetMeshWorkspaceId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetThreadId: ThreadId;
  readonly delegationId: WorkjetDelegationId;
  readonly body: WorkjetMessageBody;
  readonly ttlSeconds?: number;
}

/**
 * The delegating side requesting review: it names the reviewer address, the
 * delegation under review, the review `round`, and the signal body delivered to
 * the reviewer.
 */
export interface WorkjetMailboxRequestReviewInput {
  readonly targetWorkspaceId: WorkjetMeshWorkspaceId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetThreadId: ThreadId;
  readonly delegationId: WorkjetDelegationId;
  readonly round: number;
  readonly body: WorkjetMessageBody;
  readonly ttlSeconds?: number;
}

/** The bounded state operation `workjet_update_delegation` performs. */
export type WorkjetMailboxDelegationUpdate =
  | { readonly _tag: "cancel" }
  | {
      readonly _tag: "review";
      readonly decision: WorkjetReviewDecision;
      readonly round: number;
      readonly reasons?: ReadonlyArray<string>;
    }
  | { readonly _tag: "revise" }
  | { readonly _tag: "follow-up" };

export interface WorkjetMailboxUpdateDelegationInput {
  readonly delegationId: WorkjetDelegationId;
  readonly update: WorkjetMailboxDelegationUpdate;
}

/**
 * `state` is the delegation's state AFTER the operation; `edgeKind` is present
 * only when the operation recorded a graph edge (cancel records none).
 */
export interface WorkjetMailboxUpdateDelegationOutcome {
  readonly delegationId: WorkjetDelegationId;
  readonly state: WorkjetDelegationState;
  readonly edgeKind?: WorkjetDelegationEdgeKind;
}

export interface WorkjetMailboxReviewRequestOutcome {
  readonly delivery: WorkjetMailboxSendOutcome;
  readonly delegation: WorkjetDelegationRef;
  readonly state: WorkjetDelegationState;
  readonly edgeKind: "reviews";
}

// ===============================
// Typed thread handoff
// ===============================

/**
 * Send a handoff. The target is a MACHINE: a handoff has no target thread by
 * construction, because the receiving side creates one. The context snapshot is
 * a reference to bytes the CALLER already stored — the RPC layer composes and
 * stores them so this service never has to know how a snapshot is written, in
 * exact analogy to a delegation's prompt.
 */
export interface WorkjetMailboxSendHandoffInput {
  readonly targetWorkspaceId: WorkjetMeshWorkspaceId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly contextSnapshot: WorkjetPromptSnapshotRef;
  readonly branch?: WorkjetHandoffBranchRef;
  readonly artifacts: WorkjetArtifactReferences;
  readonly note?: string;
  readonly ttlSeconds?: number;
}

/**
 * A handoff's delivery outcome. It deliberately does NOT reuse
 * {@link WorkjetMailboxSendOutcome}: that carries a
 * {@link WorkjetDeliveryReceipt}, whose `acknowledgedBy` is a full worker
 * address including a thread id. A handoff has no target thread, and inventing
 * one to satisfy the receipt shape would put a fabricated address on the wire.
 */
export type WorkjetMailboxHandoffDeliveryOutcome =
  | {
      readonly _tag: "acknowledged";
      readonly envelopeId: WorkjetEnvelopeId;
      readonly disposition: WorkjetDeliveryDisposition;
      readonly acknowledgedAt: WorkjetMailboxTimestamp;
    }
  | { readonly _tag: "queued"; readonly envelopeId: WorkjetEnvelopeId };

export interface WorkjetMailboxSendHandoffOutcome {
  readonly delivery: WorkjetMailboxHandoffDeliveryOutcome;
  readonly handoffId: WorkjetHandoffId;
}

/**
 * Continue a received handoff HERE. `snapshotText` is the already-verified
 * context the caller read out of the local snapshot store: this service seeds
 * it as the new thread's first user message and never resolves a digest itself.
 * `hostThreadId` is the LOCAL thread whose project and runtime settings the new
 * thread inherits — a settings template and project anchor, not a parent.
 */
export interface WorkjetMailboxAcceptHandoffInput {
  readonly handoffId: WorkjetHandoffId;
  readonly hostThreadId: ThreadId;
  readonly snapshotText: string;
}

export interface WorkjetMailboxAcceptHandoffOutcome {
  readonly handoffId: WorkjetHandoffId;
  readonly threadId: ThreadId;
  readonly acceptedAt: WorkjetMailboxTimestamp;
}

export interface WorkjetMailboxDeliveryShape {
  readonly sendMessage: (
    invocation: WorkjetMailboxSenderScope,
    input: WorkjetMailboxSendMessageInput,
  ) => Effect.Effect<WorkjetMailboxSendOutcome, WorkjetMailboxError>;

  readonly delegateTask: (
    invocation: WorkjetMailboxSenderScope,
    input: WorkjetMailboxDelegateInput,
  ) => Effect.Effect<WorkjetMailboxDelegationOutcome, WorkjetMailboxError>;

  readonly reply: (
    invocation: WorkjetMailboxSenderScope,
    input: WorkjetMailboxReplyInput,
  ) => Effect.Effect<WorkjetMailboxSendOutcome, WorkjetMailboxError>;

  readonly requestReview: (
    invocation: WorkjetMailboxSenderScope,
    input: WorkjetMailboxRequestReviewInput,
  ) => Effect.Effect<WorkjetMailboxReviewRequestOutcome, WorkjetMailboxError>;

  readonly updateDelegation: (
    invocation: WorkjetMailboxSenderScope,
    input: WorkjetMailboxUpdateDelegationInput,
  ) => Effect.Effect<WorkjetMailboxUpdateDelegationOutcome, WorkjetMailboxError>;

  readonly sendHandoff: (
    invocation: WorkjetMailboxSenderScope,
    input: WorkjetMailboxSendHandoffInput,
  ) => Effect.Effect<WorkjetMailboxSendHandoffOutcome, WorkjetMailboxError>;

  /** The bounded inbox of handoffs THIS machine received, newest arrival first. */
  readonly listReceivedHandoffs: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WorkjetReceivedHandoffRecord>, WorkjetMailboxError>;

  readonly getReceivedHandoff: (
    handoffId: WorkjetHandoffId,
  ) => Effect.Effect<Option.Option<WorkjetReceivedHandoffRecord>, WorkjetMailboxError>;

  readonly acceptHandoff: (
    input: WorkjetMailboxAcceptHandoffInput,
  ) => Effect.Effect<WorkjetMailboxAcceptHandoffOutcome, WorkjetMailboxError>;
}

export class WorkjetMailboxDelivery extends Context.Service<
  WorkjetMailboxDelivery,
  WorkjetMailboxDeliveryShape
>()("t3/workjet/mailbox/WorkjetMailboxDelivery") {}

export interface WorkjetMailboxDeliverySources {
  readonly randomUUID: Effect.Effect<string>;
  readonly nowIso: Effect.Effect<string>;
  /**
   * Best-effort redacted audit sink. Optional so a unit test can omit it (a
   * no-op) or inject a capturing double; the real layer wires the shared
   * {@link WorkjetMailboxAuditEmitter}.
   */
  readonly audit?: WorkjetMailboxAuditSink;
}

// ===============================
// Helpers
// ===============================

const failure = (reason: WorkjetMailboxError["reason"]) => new WorkjetMailboxError({ reason });

/**
 * Every store failure becomes a bounded mailbox reason. A SQL failure or a
 * corrupt row must never travel to a harness as a server message: the plan
 * forbids prompts, paths, and transport detail in anything a peer can read.
 *
 * Exported because the loopback CTOX transport ingests envelopes through the
 * same store and owes a peer the same bounded vocabulary.
 */
export const boundMailboxStoreError = (cause: WorkjetMailboxStoreError): WorkjetMailboxError =>
  cause._tag === "WorkjetMailboxError" ? cause : failure("mailbox-unavailable");

const boundStoreError = boundMailboxStoreError;

/**
 * THE delegation half of accepting a delivered envelope, shared by the local
 * fast path and the loopback CTOX transport.
 *
 * Both sides must move a freshly accepted delegation `queued → delivered`
 * through the store's enforced transition table — never by rewriting the
 * delegation row — so the two paths cannot drift into two state machines. The
 * only honest difference between them is WHERE the `queued` row comes from:
 *
 * - Local fast path: sender and receiver share one store, so `delegateTask`
 *   already upserted the row when it enqueued the envelope. Re-upserting here
 *   would be refused by the store for a delegation that has since moved on, so
 *   the local caller passes `upsert: false`.
 * - Transport pull: the receiving machine has never seen this delegation, so
 *   the row must be created from the envelope's own payload first.
 *
 * Everything after that — the transition, its legality check, and the returned
 * record — is identical by construction.
 */
export const applyDeliveredDelegation = (input: {
  readonly store: WorkjetMailboxStoreShape;
  readonly delegation: WorkjetDelegation;
  readonly now: WorkjetMailboxTimestamp;
  readonly upsert: boolean;
}): Effect.Effect<WorkjetDelegationRecord, WorkjetMailboxError> =>
  Effect.gen(function* () {
    if (input.upsert) {
      yield* input.store
        .upsertDelegation(input.delegation)
        .pipe(Effect.mapError(boundMailboxStoreError));
    }
    return yield* input.store
      .transitionDelegationState(input.delegation.delegationId, "queued", "delivered", input.now)
      .pipe(Effect.mapError(boundMailboxStoreError));
  });

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

  /** Bounded, opaque audit address from a worker address (ids only). */
  const auditAddress = (address: WorkjetWorkerAddress) => ({
    workspaceId: address.workspaceId,
    environmentId: address.environmentId,
    threadId: address.threadId,
  });

  /**
   * Best-effort redacted audit emission, mirroring the best-effort activity
   * append: a failed emit never turns a delivered envelope into a reported
   * failure. It publishes AFTER the durable store write that produced the event.
   */
  const emit = (event: Parameters<typeof emitAudit>[1]) => emitAudit(sources.audit, event);

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
    readonly source: WorkjetWorkerAddress;
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
        yield* emit({
          _tag: "envelope-rejected",
          occurredAt: input.now,
          envelopeId: input.envelope.envelopeId,
          reasonCode: "invalid-signature",
        });
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
        // Emitted AFTER the durable inbound insert + delivered mark, so the
        // audit event never claims a delivery the store did not record.
        yield* emit({
          _tag: "envelope-delivered",
          occurredAt: input.now,
          envelopeId: input.envelope.envelopeId,
          source: auditAddress(input.source),
          target: auditAddress(input.target),
          disposition,
        });
      } else if (inbound._tag === "expired") {
        yield* emit({
          _tag: "envelope-rejected",
          occurredAt: input.now,
          envelopeId: input.envelope.envelopeId,
          reasonCode: "envelope-expired",
        });
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
    invocation: WorkjetMailboxSenderScope,
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

    if (enqueued._tag === "enqueued") {
      yield* emit({
        _tag: "envelope-enqueued",
        occurredAt: now,
        envelopeId: id,
        source: auditAddress(source),
        target: auditAddress(target),
      });
    }

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
        ...(input.delegationId !== undefined ? { delegationId: input.delegationId } : {}),
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
      source,
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
                ...(input.delegationId !== undefined ? { delegationId: input.delegationId } : {}),
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
      yield* emit({
        _tag: "envelope-enqueued",
        occurredAt: now,
        envelopeId: id,
        source: auditAddress(source),
        target: auditAddress(target),
        delegationId,
      });
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
      source,
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
    // never by rewriting the delegation row directly. `upsert: false` because
    // the enqueue above already wrote this delegation's `queued` row into the
    // one store both ends of the fast path share.
    const record = yield* applyDeliveredDelegation({ store, delegation, now, upsert: false });

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

  /** Loads a delegation record or fails with the exact bounded `unknown-target`. */
  const loadDelegation = (delegationId: WorkjetDelegationId) =>
    store.getDelegation(delegationId).pipe(
      Effect.mapError(boundStoreError),
      Effect.flatMap((option) =>
        Option.match(option, {
          onNone: () => Effect.fail(failure("unknown-target")),
          onSome: (record) => Effect.succeed(record),
        }),
      ),
    );

  /**
   * A `workjet_reply` reuses the message fast path verbatim; the only additions
   * are that it references the delegation's envelope (`inReplyTo`) and tags the
   * thread activity with the delegation id. No task, no lifecycle transition.
   */
  const reply: WorkjetMailboxDeliveryShape["reply"] = Effect.fn("WorkjetMailboxDelivery.reply")(
    function* (invocation, input) {
      const record = yield* loadDelegation(input.delegationId);
      return yield* sendMessage(invocation, {
        targetWorkspaceId: input.targetWorkspaceId,
        targetEnvironmentId: input.targetEnvironmentId,
        targetThreadId: input.targetThreadId,
        body: input.body,
        inReplyTo: record.delegation.envelopeId,
        delegationId: input.delegationId,
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
      });
    },
  );

  /**
   * The delegating side requesting review. It moves the delegation
   * `running → review-requested` through the store's enforced transition table,
   * records the `reviews` relationship as a graph edge, and emits the
   * review-request signal to the reviewer address. The review-round budget is
   * the loop gate: a round beyond `maxReviewRounds` is refused BEFORE any
   * durable effect, so the review cycle terminates.
   */
  const requestReview: WorkjetMailboxDeliveryShape["requestReview"] = Effect.fn(
    "WorkjetMailboxDelivery.requestReview",
  )(function* (invocation, input) {
    const record = yield* loadDelegation(input.delegationId);
    const delegation = record.delegation;

    if (input.round > delegation.budget.maxReviewRounds) {
      return yield* failure("review-rounds-exceeded");
    }

    const now = yield* sources.nowIso;
    const transitioned = yield* store
      .transitionDelegationState(input.delegationId, "running", "review-requested", now)
      .pipe(Effect.mapError(boundStoreError));

    const { target: reviewer } = resolveAddresses(invocation, input);
    const reviewedRef: WorkjetDelegationRef = {
      schemaVersion: 1,
      delegationId: input.delegationId,
      owner: delegation.target,
    };
    const reviewerRef: WorkjetDelegationRef = {
      schemaVersion: 1,
      delegationId: input.delegationId,
      owner: reviewer,
    };
    const edge: WorkjetDelegationEdge = {
      schemaVersion: 1,
      kind: "reviews",
      from: reviewerRef,
      to: reviewedRef,
      createdAt: now,
      depth: delegation.depth,
    };
    yield* store.insertDelegationEdge(edge).pipe(Effect.mapError(boundStoreError));

    const delivery = yield* sendMessage(invocation, {
      targetWorkspaceId: input.targetWorkspaceId,
      targetEnvironmentId: input.targetEnvironmentId,
      targetThreadId: input.targetThreadId,
      body: input.body,
      inReplyTo: delegation.envelopeId,
      delegationId: input.delegationId,
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    });

    return {
      delivery,
      delegation: reviewedRef,
      state: transitioned.state,
      edgeKind: "reviews",
    } as const satisfies WorkjetMailboxReviewRequestOutcome;
  });

  /**
   * The bounded state operations on an existing delegation. Every branch maps
   * to ONE legal transition in the store's enforced table (never a new one) and,
   * where it creates a relationship, writes ONE graph edge. `revise` and
   * `follow-up` deepen the graph, so both are gated on the delegation's
   * `maxDepth` budget: an edge one level below the ceiling is refused BEFORE the
   * transition, so the graph cannot grow without bound.
   */
  const updateDelegation: WorkjetMailboxDeliveryShape["updateDelegation"] = Effect.fn(
    "WorkjetMailboxDelivery.updateDelegation",
  )(function* (invocation, input) {
    const record = yield* loadDelegation(input.delegationId);
    const delegation = record.delegation;
    const now = yield* sources.nowIso;

    const { source: actor } = resolveAddresses(invocation, {
      targetWorkspaceId: delegation.target.workspaceId,
      targetEnvironmentId: delegation.target.environmentId,
      targetThreadId: delegation.target.threadId,
    });

    const reviewedRef: WorkjetDelegationRef = {
      schemaVersion: 1,
      delegationId: input.delegationId,
      owner: delegation.target,
    };
    const originatingRef: WorkjetDelegationRef = {
      schemaVersion: 1,
      delegationId: input.delegationId,
      owner: delegation.source,
    };
    const actorRef: WorkjetDelegationRef = {
      schemaVersion: 1,
      delegationId: input.delegationId,
      owner: actor,
    };

    const writeEdge = (
      kind: WorkjetDelegationEdgeKind,
      from: WorkjetDelegationRef,
      to: WorkjetDelegationRef,
      depth: number,
    ) =>
      store
        .insertDelegationEdge({ schemaVersion: 1, kind, from, to, createdAt: now, depth })
        .pipe(Effect.mapError(boundStoreError));

    const transition = (from: WorkjetDelegationState, to: WorkjetDelegationState) =>
      store
        .transitionDelegationState(input.delegationId, from, to, now)
        .pipe(Effect.mapError(boundStoreError));

    switch (input.update._tag) {
      case "cancel": {
        // Any non-terminal state may be cancelled; the store's transition table
        // refuses a cancel of an already-terminal delegation as
        // `invalid-state-transition`. No relationship, so no edge.
        const result = yield* transition(record.state, "cancelled");
        return {
          delegationId: input.delegationId,
          state: result.state,
        } as const satisfies WorkjetMailboxUpdateDelegationOutcome;
      }
      case "review": {
        if (input.update.round > delegation.budget.maxReviewRounds) {
          return yield* failure("review-rounds-exceeded");
        }
        const to: WorkjetDelegationState =
          input.update.decision === "approve" ? "completed" : "changes-requested";
        const result = yield* transition("review-requested", to);
        yield* writeEdge("reviews", actorRef, reviewedRef, delegation.depth);
        return {
          delegationId: input.delegationId,
          state: result.state,
          edgeKind: "reviews",
        } as const satisfies WorkjetMailboxUpdateDelegationOutcome;
      }
      case "revise": {
        const depth = delegation.depth + 1;
        if (depth > delegation.budget.maxDepth) {
          return yield* failure("depth-exceeded");
        }
        const result = yield* transition("changes-requested", "running");
        yield* writeEdge("revises", actorRef, reviewedRef, depth);
        return {
          delegationId: input.delegationId,
          state: result.state,
          edgeKind: "revises",
        } as const satisfies WorkjetMailboxUpdateDelegationOutcome;
      }
      case "follow-up": {
        const depth = delegation.depth + 1;
        if (depth > delegation.budget.maxDepth) {
          return yield* failure("depth-exceeded");
        }
        const result = yield* transition("running", "needs-input");
        yield* writeEdge("follows-up", actorRef, originatingRef, depth);
        return {
          delegationId: input.delegationId,
          state: result.state,
          edgeKind: "follows-up",
        } as const satisfies WorkjetMailboxUpdateDelegationOutcome;
      }
    }
  });

  // -----------------------------
  // Typed thread handoff
  // -----------------------------

  const handoffIdEffect = sources.randomUUID.pipe(
    Effect.map((uuid) => WorkjetHandoffId.make(`wjh-${uuid}`)),
  );

  /**
   * Redacted handoff activity: ids, addresses, and the snapshot's SIZE. Never
   * the snapshot text, never the operator note.
   */
  const handoffActivityPayload = (input: {
    readonly envelopeId: WorkjetEnvelopeId;
    readonly handoffId: WorkjetHandoffId;
    readonly direction: "outbound" | "inbound";
    readonly sourceThread: WorkjetWorkerAddress;
    readonly targetWorkspaceId: WorkjetMeshWorkspaceId;
    readonly targetEnvironmentId: EnvironmentId;
    readonly acceptedThreadId?: ThreadId;
    readonly snapshotByteLength: number;
    readonly createdAt: WorkjetMailboxTimestamp;
    readonly expiresAt: WorkjetMailboxTimestamp;
  }) => ({
    schemaVersion: 1 as const,
    envelopeId: input.envelopeId,
    handoffId: input.handoffId,
    direction: input.direction,
    sourceThread: {
      workspaceId: input.sourceThread.workspaceId,
      environmentId: input.sourceThread.environmentId,
      threadId: input.sourceThread.threadId,
    },
    targetWorkspaceId: input.targetWorkspaceId,
    targetEnvironmentId: input.targetEnvironmentId,
    ...(input.acceptedThreadId !== undefined ? { acceptedThreadId: input.acceptedThreadId } : {}),
    snapshotByteLength: input.snapshotByteLength,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });

  const sendHandoff: WorkjetMailboxDeliveryShape["sendHandoff"] = Effect.fn(
    "WorkjetMailboxDelivery.sendHandoff",
  )(function* (invocation, input) {
    const sourceThread: WorkjetWorkerAddress = {
      schemaVersion: 1,
      workspaceId: identity.workspaceId,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
    };
    const sameEnvironment = invocation.environmentId === input.targetEnvironmentId;

    const now = yield* sources.nowIso;
    const expiresAt = yield* addSeconds(now, clampTtlSeconds(input.ttlSeconds));
    const id = yield* envelopeId;
    const handoffId = yield* handoffIdEffect;

    const handoff: WorkjetThreadHandoff = {
      schemaVersion: 1,
      envelopeId: id,
      handoffId,
      sourceThread,
      target: {
        schemaVersion: 1,
        workspaceId: input.targetWorkspaceId,
        environmentId: input.targetEnvironmentId,
      },
      createdAt: now,
      expiresAt,
      contextSnapshot: input.contextSnapshot,
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      artifacts: input.artifacts,
      ...(input.note !== undefined ? { note: input.note } : {}),
    };

    const payload = { _tag: "handoff", handoff } as const satisfies WorkjetMailboxPayload;
    // The routing envelope's addresses are workspace/environment pairs, which is
    // exactly what a handoff has; no thread id is invented to fill the shape.
    const envelope = yield* identity.signRoutingEnvelope({
      schemaVersion: 1,
      envelopeId: id,
      kind: "handoff",
      sourceWorkspaceId: sourceThread.workspaceId,
      sourceEnvironmentId: sourceThread.environmentId,
      targetWorkspaceId: input.targetWorkspaceId,
      targetEnvironmentId: input.targetEnvironmentId,
      createdAt: now,
      expiresAt,
    });

    const enqueued = yield* store
      .enqueueOutbound(envelope, payload)
      .pipe(Effect.mapError(boundStoreError));

    if (enqueued._tag === "enqueued") {
      yield* emit({
        _tag: "envelope-enqueued",
        occurredAt: now,
        envelopeId: id,
        source: auditAddress(sourceThread),
        // A handoff has no target thread; the audit address reuses the SOURCE
        // thread id rather than inventing a target one, and the envelope id is
        // what actually identifies the traffic.
        target: {
          workspaceId: input.targetWorkspaceId,
          environmentId: input.targetEnvironmentId,
          threadId: sourceThread.threadId,
        },
      });
    }

    yield* appendActivity({
      threadId: sourceThread.threadId,
      kind: WORKJET_HANDOFF_SENT_ACTIVITY_KIND,
      summary: sameEnvironment ? "Workjet handoff sent" : "Workjet handoff queued",
      payload: handoffActivityPayload({
        envelopeId: id,
        handoffId,
        direction: "outbound",
        sourceThread,
        targetWorkspaceId: input.targetWorkspaceId,
        targetEnvironmentId: input.targetEnvironmentId,
        snapshotByteLength: input.contextSnapshot.byteLength,
        createdAt: now,
        expiresAt,
      }),
      createdAt: now,
    });

    if (!sameEnvironment) {
      return {
        delivery: { _tag: "queued", envelopeId: id } as const,
        handoffId,
      } as const satisfies WorkjetMailboxSendHandoffOutcome;
    }

    // The same-environment fast path, obeying the same contracts and state
    // machine as remote delivery: verify, record inbound, mark delivered, then
    // record the handoff in the receiving table.
    const verified = yield* identity.verifyRoutingEnvelope(envelope);
    if (!verified) {
      yield* emit({
        _tag: "envelope-rejected",
        occurredAt: now,
        envelopeId: id,
        reasonCode: "invalid-signature",
      });
      return yield* failure("invalid-signature");
    }

    const inbound = yield* store
      .recordInboundEnvelope(envelope, payload, now)
      .pipe(Effect.mapError(boundStoreError));

    if (inbound._tag === "accepted-new") {
      yield* store.markDelivered(id, now).pipe(Effect.mapError(boundStoreError));
      // Idempotent on the handoff id, so a replay adds no second inbox entry.
      yield* store.upsertReceivedHandoff(handoff, now).pipe(Effect.mapError(boundStoreError));
      yield* emit({
        _tag: "envelope-delivered",
        occurredAt: now,
        envelopeId: id,
        source: auditAddress(sourceThread),
        target: {
          workspaceId: input.targetWorkspaceId,
          environmentId: input.targetEnvironmentId,
          threadId: sourceThread.threadId,
        },
        disposition: inbound._tag,
      });
    } else if (inbound._tag === "expired") {
      yield* emit({
        _tag: "envelope-rejected",
        occurredAt: now,
        envelopeId: id,
        reasonCode: "envelope-expired",
      });
    }

    return {
      delivery: {
        _tag: "acknowledged",
        envelopeId: id,
        disposition: inbound._tag,
        acknowledgedAt: now,
      } as const,
      handoffId,
    } as const satisfies WorkjetMailboxSendHandoffOutcome;
  });

  const listReceivedHandoffs: WorkjetMailboxDeliveryShape["listReceivedHandoffs"] = (limit) =>
    store.listReceivedHandoffs(limit).pipe(Effect.mapError(boundStoreError));

  const getReceivedHandoff: WorkjetMailboxDeliveryShape["getReceivedHandoff"] = (handoffId) =>
    store.getReceivedHandoff(handoffId).pipe(Effect.mapError(boundStoreError));

  /**
   * Continue a received handoff in a NEW local thread.
   *
   * Order of effects, and why: the thread is created FIRST and the exactly-once
   * claim on the handoff row is taken SECOND.
   *
   * - Claiming first would need a thread id chosen before the thread exists; a
   *   failed creation would then leave the handoff permanently marked accepted,
   *   pointing at a thread nobody can open. That is the worse failure: it is
   *   invisible and unrecoverable through the ordinary surface.
   * - Creating first means a lost race (two accepts at once) produces one extra
   *   brand-new thread, which this function immediately deletes — it owns that
   *   thread, nothing else has referenced it yet, and the database's `WHERE
   *   accepted_thread_id IS NULL` guard is what decides the winner. The
   *   invariant the plan actually demands — a handoff yields EXACTLY ONE
   *   continuing thread — is preserved by the store, not by request ordering.
   */
  const acceptHandoff: WorkjetMailboxDeliveryShape["acceptHandoff"] = Effect.fn(
    "WorkjetMailboxDelivery.acceptHandoff",
  )(function* (input) {
    const record = yield* store
      .getReceivedHandoff(input.handoffId)
      .pipe(Effect.mapError(boundStoreError));
    const handoffRecord = yield* Option.match(record, {
      onNone: () => Effect.fail(failure("unknown-target")),
      onSome: (value) => Effect.succeed(value),
    });
    // A handoff already continued somewhere is not continued a second time.
    if (handoffRecord.acceptedThreadId !== null) {
      return yield* failure("invalid-state-transition");
    }

    const host = yield* requireLocalTargetThread(input.hostThreadId);

    const now = yield* sources.nowIso;
    const threadId = ThreadId.make(yield* sources.randomUUID);
    const handoff = handoffRecord.handoff;

    const createCommand = {
      type: "thread.create",
      commandId: CommandId.make(yield* sources.randomUUID),
      threadId,
      projectId: host.projectId,
      title: `Handoff: ${handoff.sourceThread.threadId}`,
      modelSelection: host.modelSelection,
      runtimeMode: host.runtimeMode,
      interactionMode: host.interactionMode,
      // A continued handoff is an ordinary standalone thread. It is deliberately
      // NOT a `worker` of the host thread: the host supplies project and runtime
      // settings, not authority, and a worker role would imply a parent that
      // never dispatched it.
      workjetConfig: {
        schemaVersion: 2,
        role: "standard",
        parent: null,
        managedInstructions: "",
        enabledCapabilityIds: [],
        capabilityBindings: [],
      },
      // No worktree and no branch checkout: the handed-over branch may not exist
      // on this machine at all, and fetching it is an explicit operator action.
      branch: null,
      worktreePath: null,
      createdAt: now,
    } as const satisfies OrchestrationCommand;

    const createExit = yield* Effect.exit(engine.dispatch(createCommand));
    if (createExit._tag === "Failure") {
      return yield* failure("mailbox-unavailable");
    }

    const deleteThread = Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(yield* sources.randomUUID),
        threadId,
      } as const satisfies OrchestrationCommand);
    }).pipe(Effect.ignore);

    // The snapshot IS the first user message: the new thread starts from the
    // bounded continuation brief, with any harness or model the host supplies.
    const turnExit = yield* Effect.exit(
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(yield* sources.randomUUID),
          threadId,
          message: {
            messageId: MessageId.make(yield* sources.randomUUID),
            role: "user",
            text: input.snapshotText,
            attachments: [],
          },
          runtimeMode: host.runtimeMode,
          interactionMode: host.interactionMode,
          createdAt: now,
        } as const satisfies OrchestrationCommand);
      }),
    );
    if (turnExit._tag === "Failure") {
      yield* deleteThread;
      return yield* failure("mailbox-unavailable");
    }

    const claimed = yield* Effect.exit(
      store.markReceivedHandoffAccepted(input.handoffId, threadId, now),
    );
    if (claimed._tag === "Failure") {
      // Another accept won, or the row vanished. The thread this call created is
      // brand new and unreferenced, so removing it keeps "exactly one thread per
      // handoff" true from the operator's point of view.
      yield* deleteThread;
      return yield* failure("invalid-state-transition");
    }

    // The durable backlink, on the NEW thread's own event stream: it names the
    // source address, so the thread carries the link to the work it continues
    // even for a reader who never queries the handoff table.
    yield* appendActivity({
      threadId,
      kind: WORKJET_HANDOFF_ACCEPTED_ACTIVITY_KIND,
      summary: "Workjet handoff continued here",
      payload: handoffActivityPayload({
        envelopeId: handoff.envelopeId,
        handoffId: handoff.handoffId,
        direction: "inbound",
        sourceThread: handoff.sourceThread,
        targetWorkspaceId: handoff.target.workspaceId,
        targetEnvironmentId: handoff.target.environmentId,
        acceptedThreadId: threadId,
        snapshotByteLength: handoff.contextSnapshot.byteLength,
        createdAt: handoff.createdAt,
        expiresAt: handoff.expiresAt,
      }),
      createdAt: now,
    });

    // Tell the SOURCE thread its work was picked up — but only when it lives on
    // this machine. For a source on another machine this server has no envelope
    // kind to carry an acknowledgement, and appending to a thread id it does not
    // own would write the activity onto the wrong thread. The acceptance stays
    // durable on the handoff row either way.
    // This server IS the handoff target, so "the source is local" is exactly
    // "the handoff never crossed a machine boundary".
    if (handoff.sourceThread.environmentId === handoff.target.environmentId) {
      yield* appendActivity({
        threadId: handoff.sourceThread.threadId,
        kind: WORKJET_HANDOFF_ACCEPTED_ACTIVITY_KIND,
        summary: "Workjet handoff continued on the target machine",
        payload: handoffActivityPayload({
          envelopeId: handoff.envelopeId,
          handoffId: handoff.handoffId,
          direction: "outbound",
          sourceThread: handoff.sourceThread,
          targetWorkspaceId: handoff.target.workspaceId,
          targetEnvironmentId: handoff.target.environmentId,
          acceptedThreadId: threadId,
          snapshotByteLength: handoff.contextSnapshot.byteLength,
          createdAt: handoff.createdAt,
          expiresAt: handoff.expiresAt,
        }),
        createdAt: now,
      });
    }

    return {
      handoffId: input.handoffId,
      threadId,
      acceptedAt: now,
    } as const satisfies WorkjetMailboxAcceptHandoffOutcome;
  });

  return WorkjetMailboxDelivery.of({
    sendMessage,
    delegateTask,
    reply,
    requestReview,
    updateDelegation,
    sendHandoff,
    listReceivedHandoffs,
    getReceivedHandoff,
    acceptHandoff,
  });
});

export const makeWorkjetMailboxDelivery = Effect.fn("WorkjetMailboxDelivery.make")(function* () {
  const crypto = yield* Crypto.Crypto;
  const auditEmitter = yield* WorkjetMailboxAuditEmitter;
  return yield* makeWorkjetMailboxDeliveryWithSources({
    randomUUID: crypto.randomUUIDv4.pipe(Effect.orDie),
    nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    audit: { emit: auditEmitter.publish },
  });
});

export const layer = Layer.effect(WorkjetMailboxDelivery, makeWorkjetMailboxDelivery());
