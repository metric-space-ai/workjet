// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Redacted audit / observability events and user notifications for the
 * distributed Workjet worker mailbox and delegation graph.
 *
 * These contracts implement `docs/workjet-plan.md` Wave 5: "Add redacted
 * audit/observability events and user notifications without storing prompts,
 * secrets, provider payloads, or artifact contents in relay logs, traces, push
 * notifications, or crash reports."
 *
 * The single hard constraint of every schema in this module is REDACTION. An
 * audit event may carry only:
 *
 * - envelope ids, delegation ids;
 * - bounded opaque addresses (workspace / environment / thread ids);
 * - lifecycle state transitions and terminal outcomes;
 * - dispositions and bounded reason CODES (never a server message);
 * - non-negative counters and bounded timestamps.
 *
 * It may NEVER carry message text, prompt text, snapshot bytes or the sealed
 * payload reference, artifact contents, secrets, capability tokens, or provider
 * payloads. Because every field below is a bounded id, a closed literal, an
 * integer, or a timestamp, a would-be secret has no field to travel in: an
 * object carrying one decodes with the excess key DROPPED, never surfaced.
 *
 * A {@link WorkjetMailboxNotification} is the user-facing subset. Its
 * human-readable title/detail are BUILT from ids and codes only
 * ({@link toWorkjetMailboxNotification}); no free text ever flows from a
 * payload into a notification.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import {
  WORKJET_MAILBOX_SCHEMA_VERSION,
  WorkjetDelegationId,
  WorkjetDelegationOutcome,
  WorkjetDelegationState,
  WorkjetDeliveryDisposition,
  WorkjetEnvelopeId,
  WorkjetMailboxFailureReason,
  WorkjetMailboxTimestamp,
  WorkjetMeshWorkspaceId,
} from "./workjetMailbox.ts";

/** Current schema version of every contract in this module (tracks the mailbox). */
export const WORKJET_MAILBOX_AUDIT_SCHEMA_VERSION = WORKJET_MAILBOX_SCHEMA_VERSION;

const AuditSchemaVersion = Schema.Literal(WORKJET_MAILBOX_AUDIT_SCHEMA_VERSION);

/**
 * Bounded, opaque worker address. Structurally identical to the mailbox
 * activity address: a workspace/mesh authority id, an environment id, and a
 * thread id — all opaque handles, never an account, device, or credential.
 */
export const WorkjetMailboxAuditAddress = Schema.Struct({
  workspaceId: WorkjetMeshWorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type WorkjetMailboxAuditAddress = typeof WorkjetMailboxAuditAddress.Type;

/**
 * The bounded reason vocabulary for a mesh replication failure. It is a small
 * closed set of CODES describing why a cross-machine push could not be
 * replicated — never the daemon's status text, an HTTP body, or a peer address.
 */
export const WorkjetMailboxMeshReplicationReason = Schema.Literals([
  "recipient-key-unknown",
  "encode-failed",
  "payload-too-large",
  "publish-failed",
  "transport-unavailable",
]);
export type WorkjetMailboxMeshReplicationReason = typeof WorkjetMailboxMeshReplicationReason.Type;

/** Which budget dimension a delegation exhausted. */
export const WorkjetMailboxBudgetKind = Schema.Literals(["tokens", "cost"]);
export type WorkjetMailboxBudgetKind = typeof WorkjetMailboxBudgetKind.Type;

/**
 * A monotone, per-stream sequence number the emitter stamps on every event, so
 * a subscriber can detect a gap after a sliding-buffer drop. Bounded to a safe
 * JS integer.
 */
export const WorkjetMailboxAuditSequence = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export type WorkjetMailboxAuditSequence = typeof WorkjetMailboxAuditSequence.Type;

/** Fields every audit event carries. */
const auditEventBase = {
  schemaVersion: AuditSchemaVersion,
  /** Monotone per-stream sequence; a gap signals a dropped (sliding) event. */
  sequence: WorkjetMailboxAuditSequence,
  /** When the underlying durable transition was observed. */
  occurredAt: WorkjetMailboxTimestamp,
} as const;

/**
 * The redacted mailbox audit event — a tagged union over the observable
 * lifecycle moments of the mailbox and delegation graph. Every variant carries
 * ONLY bounded ids, addresses, states, dispositions, reason codes, counters,
 * and timestamps.
 */
export const WorkjetMailboxAuditEvent = Schema.Union([
  /** An outbound envelope was durably enqueued. */
  Schema.TaggedStruct("envelope-enqueued", {
    ...auditEventBase,
    envelopeId: WorkjetEnvelopeId,
    source: WorkjetMailboxAuditAddress,
    target: WorkjetMailboxAuditAddress,
    /** Present when the envelope carries a delegation. */
    delegationId: Schema.optionalKey(WorkjetDelegationId),
  }),
  /** An envelope was accepted (delivered) into a durable inbox. */
  Schema.TaggedStruct("envelope-delivered", {
    ...auditEventBase,
    envelopeId: WorkjetEnvelopeId,
    source: WorkjetMailboxAuditAddress,
    target: WorkjetMailboxAuditAddress,
    disposition: WorkjetDeliveryDisposition,
    delegationId: Schema.optionalKey(WorkjetDelegationId),
  }),
  /** An envelope reached its terminal dead-letter state after exhausting attempts. */
  Schema.TaggedStruct("envelope-dead-lettered", {
    ...auditEventBase,
    envelopeId: WorkjetEnvelopeId,
    attemptCount: NonNegativeInt,
  }),
  /** An inbound envelope was refused with a bounded reason code. */
  Schema.TaggedStruct("envelope-rejected", {
    ...auditEventBase,
    envelopeId: WorkjetEnvelopeId,
    reasonCode: WorkjetMailboxFailureReason,
  }),
  /** A delegation moved between two lifecycle states. */
  Schema.TaggedStruct("delegation-state-changed", {
    ...auditEventBase,
    delegationId: WorkjetDelegationId,
    envelopeId: WorkjetEnvelopeId,
    source: WorkjetMailboxAuditAddress,
    target: WorkjetMailboxAuditAddress,
    from: WorkjetDelegationState,
    to: WorkjetDelegationState,
  }),
  /** A delegation is gated on human approval and will not run until approved. */
  Schema.TaggedStruct("delegation-approval-required", {
    ...auditEventBase,
    delegationId: WorkjetDelegationId,
    envelopeId: WorkjetEnvelopeId,
    source: WorkjetMailboxAuditAddress,
    target: WorkjetMailboxAuditAddress,
  }),
  /** A delegation reached a terminal outcome. */
  Schema.TaggedStruct("delegation-completed", {
    ...auditEventBase,
    delegationId: WorkjetDelegationId,
    envelopeId: WorkjetEnvelopeId,
    source: WorkjetMailboxAuditAddress,
    target: WorkjetMailboxAuditAddress,
    outcome: WorkjetDelegationOutcome,
  }),
  /** A delegation charge was refused because a budget ceiling would be crossed. */
  Schema.TaggedStruct("budget-exceeded", {
    ...auditEventBase,
    delegationId: WorkjetDelegationId,
    kind: WorkjetMailboxBudgetKind,
  }),
  /** A cross-machine replication push failed with a bounded reason code. */
  Schema.TaggedStruct("mesh-replication-error", {
    ...auditEventBase,
    envelopeId: WorkjetEnvelopeId,
    reasonCode: WorkjetMailboxMeshReplicationReason,
  }),
]);
export type WorkjetMailboxAuditEvent = typeof WorkjetMailboxAuditEvent.Type;

/** The discriminator tags of {@link WorkjetMailboxAuditEvent}. */
export type WorkjetMailboxAuditEventTag = WorkjetMailboxAuditEvent["_tag"];

/**
 * The user-facing subset of audit events, as a notification kind. Only the
 * moments a human should be told about: an approval gate, a dead-lettered
 * envelope, an exhausted budget, and a finished delegation.
 */
export const WORKJET_MAILBOX_NOTIFICATION_TAGS = [
  "delegation-approval-required",
  "envelope-dead-lettered",
  "budget-exceeded",
  "delegation-completed",
] as const satisfies ReadonlyArray<WorkjetMailboxAuditEventTag>;
export type WorkjetMailboxNotificationTag = (typeof WORKJET_MAILBOX_NOTIFICATION_TAGS)[number];

/** Severity of a notification, derived from the event, never from a payload. */
export const WorkjetMailboxNotificationLevel = Schema.Literals(["info", "warning"]);
export type WorkjetMailboxNotificationLevel = typeof WorkjetMailboxNotificationLevel.Type;

/**
 * Bounded, human-safe title/detail. The strings are BUILT from ids and codes
 * (see {@link toWorkjetMailboxNotification}); they are bounded here purely as a
 * wire-safety ceiling, and contain no free text lifted from any payload.
 */
const NotificationText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const WorkjetMailboxNotification = Schema.Struct({
  schemaVersion: AuditSchemaVersion,
  /** Which notification-worthy event this describes. */
  kind: Schema.Literals(WORKJET_MAILBOX_NOTIFICATION_TAGS),
  level: WorkjetMailboxNotificationLevel,
  sequence: WorkjetMailboxAuditSequence,
  occurredAt: WorkjetMailboxTimestamp,
  /** Short bounded title, built from ids + codes only. */
  title: NotificationText,
  /** Bounded one-line detail, built from ids + codes only. */
  detail: NotificationText,
  /** The delegation this notification concerns, when it has one. */
  delegationId: Schema.optionalKey(WorkjetDelegationId),
  /** The envelope this notification concerns, when it has one. */
  envelopeId: Schema.optionalKey(WorkjetEnvelopeId),
});
export type WorkjetMailboxNotification = typeof WorkjetMailboxNotification.Type;

/** Whether an audit event belongs to the user-facing notification subset. */
export const isWorkjetMailboxNotificationEvent = (
  event: WorkjetMailboxAuditEvent,
): event is Extract<WorkjetMailboxAuditEvent, { readonly _tag: WorkjetMailboxNotificationTag }> =>
  (WORKJET_MAILBOX_NOTIFICATION_TAGS as ReadonlyArray<string>).includes(event._tag);

/**
 * Bounded, redaction-safe notification derived from an audit event. Returns
 * `null` for an event outside the user-facing subset. Every string is composed
 * from bounded ids and closed reason codes; no payload free text is ever read.
 */
export const toWorkjetMailboxNotification = (
  event: WorkjetMailboxAuditEvent,
): WorkjetMailboxNotification | null => {
  const common = {
    schemaVersion: WORKJET_MAILBOX_AUDIT_SCHEMA_VERSION,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
  } as const;
  switch (event._tag) {
    case "delegation-approval-required":
      return {
        ...common,
        kind: "delegation-approval-required",
        level: "warning",
        title: "Delegation needs approval",
        detail: `Delegation ${event.delegationId} is waiting for human approval before it can run.`,
        delegationId: event.delegationId,
        envelopeId: event.envelopeId,
      };
    case "envelope-dead-lettered":
      return {
        ...common,
        kind: "envelope-dead-lettered",
        level: "warning",
        title: "Envelope could not be delivered",
        detail: `Envelope ${event.envelopeId} was dead-lettered after ${event.attemptCount} delivery attempts.`,
        envelopeId: event.envelopeId,
      };
    case "budget-exceeded":
      return {
        ...common,
        kind: "budget-exceeded",
        level: "warning",
        title: "Delegation budget exhausted",
        detail: `Delegation ${event.delegationId} exceeded its ${event.kind} budget and was refused.`,
        delegationId: event.delegationId,
      };
    case "delegation-completed":
      return {
        ...common,
        kind: "delegation-completed",
        level: event.outcome === "completed" ? "info" : "warning",
        title: "Delegation finished",
        detail: `Delegation ${event.delegationId} finished with outcome ${event.outcome}.`,
        delegationId: event.delegationId,
        envelopeId: event.envelopeId,
      };
    default:
      return null;
  }
};
