import {
  WorkjetDelegation,
  WorkjetDelegationApprovalState,
  WorkjetDelegationEdge,
  WorkjetDelegationId,
  WorkjetDelegationResult,
  WorkjetDelegationState,
  WorkjetEnvelopeId,
  WorkjetMailboxError,
  WorkjetMailboxPayload,
  WorkjetMailboxTimestamp,
  WorkjetMeshWorkspaceId,
  WorkjetRoutingEnvelope,
  WORKJET_TERMINAL_DELEGATION_STATES,
  EnvironmentId,
  WORKJET_MESH_ROSTER_MAX_PEERS,
  type WorkjetDelegationRef,
  type WorkjetWorkerAddress,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../../persistence/Errors.ts";

/**
 * Durable, transactional Workjet mailbox store (docs/workjet-plan.md →
 * "Distributed worker mailbox and delegation graph").
 *
 * This module owns the LOCAL durable store and its invariants only. Transport,
 * relay, CTOX-Sync replication, reconciler scheduling, and UI are deliberately
 * out of scope: nothing here opens a connection or decides when to send.
 *
 * Invariants:
 *
 * 1. Every stored value is encoded and decoded through the contract schemas in
 *    `@t3tools/contracts`; no hand-rolled JSON shape exists in this file.
 * 2. Inbox insertion is idempotent on the stable envelope id, so at-least-once
 *    transport produces exactly-once local effects.
 * 3. A delegation state change validates the transition and writes the new
 *    state in ONE transaction, so a concurrent transition cannot slip between
 *    the check and the write.
 * 4. A row that fails to decode surfaces as {@link WorkjetMailboxStoreCorruptRowError},
 *    never as a defect or a crash.
 */

// ===============================
// Backoff and delivery budget
// ===============================

/** First retry delay; every further attempt doubles it. */
export const WORKJET_MAILBOX_BASE_BACKOFF_MILLIS = 1_000;

/** Ceiling of the exponential backoff, so retries stay bounded. */
export const WORKJET_MAILBOX_MAX_BACKOFF_MILLIS = 300_000;

/**
 * Number of delivery attempts after which a pending outbox row moves to the
 * terminal `dead` state. The dead-letter state is reachable and queryable via
 * {@link WorkjetMailboxStore} `listOutboundByState`.
 */
export const WORKJET_MAILBOX_MAX_DELIVERY_ATTEMPTS = 8;

/**
 * Bounded exponential backoff for the given (already incremented) attempt
 * count. Deterministic on purpose: the reconciler that will later consume this
 * store must be reproducible, and jitter belongs to the transport, not to the
 * durable record.
 */
export const workjetMailboxBackoffMillis = (attemptCount: number): number => {
  const exponent = Math.max(0, attemptCount - 1);
  const scaled = WORKJET_MAILBOX_BASE_BACKOFF_MILLIS * Math.pow(2, Math.min(exponent, 32));
  return Math.min(WORKJET_MAILBOX_MAX_BACKOFF_MILLIS, scaled);
};

// ===============================
// Delegation transition table
// ===============================

const TERMINAL_DELEGATION_STATES: ReadonlySet<WorkjetDelegationState> = new Set(
  WORKJET_TERMINAL_DELEGATION_STATES,
);

export const isTerminalDelegationState = (state: WorkjetDelegationState): boolean =>
  TERMINAL_DELEGATION_STATES.has(state);

/**
 * The legal delegation lifecycle, derived from the plan's state list:
 *
 *   queued → delivered → accepted → running
 *   running ↔ needs-input
 *   running → review-requested
 *   running → completed
 *   review-requested → changes-requested → running
 *   review-requested → completed
 *   any non-terminal → cancelled | expired | failed
 *   completed | failed | cancelled | expired are TERMINAL and immutable
 *
 * The terminal escapes are appended programmatically below, so the literal map
 * only carries the forward progress edges. `running → completed` exists for
 * delegations whose budget carries `maxReviewRounds: 0` — a review is a
 * configurable gate, not a mandatory one; delegations that request review
 * still complete through `review-requested`.
 */
const DELEGATION_PROGRESS_TRANSITIONS = {
  queued: ["delivered"],
  delivered: ["accepted"],
  accepted: ["running"],
  running: ["needs-input", "review-requested", "completed"],
  "needs-input": ["running"],
  "review-requested": ["changes-requested", "completed"],
  "changes-requested": ["running"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
} as const satisfies Record<WorkjetDelegationState, ReadonlyArray<WorkjetDelegationState>>;

const TERMINAL_ESCAPES = [
  "cancelled",
  "expired",
  "failed",
] as const satisfies ReadonlyArray<WorkjetDelegationState>;

const LEGAL_DELEGATION_TRANSITIONS: ReadonlyMap<
  WorkjetDelegationState,
  ReadonlySet<WorkjetDelegationState>
> = new Map(
  (
    Object.entries(DELEGATION_PROGRESS_TRANSITIONS) as ReadonlyArray<
      readonly [WorkjetDelegationState, ReadonlyArray<WorkjetDelegationState>]
    >
  ).map(([from, to]) => [
    from,
    new Set<WorkjetDelegationState>(
      isTerminalDelegationState(from) ? [] : [...to, ...TERMINAL_ESCAPES],
    ),
  ]),
);

export const isLegalDelegationTransition = (
  from: WorkjetDelegationState,
  to: WorkjetDelegationState,
): boolean => LEGAL_DELEGATION_TRANSITIONS.get(from)?.has(to) === true;

// ===============================
// Delegation graph edge identity
// ===============================

/**
 * Stable, deterministic identity of a delegation-graph edge, derived from its
 * `kind` and its two endpoint refs (`from`, `to`) — exactly the three fields the
 * plan names. It is the edge table's primary key, so a re-inserted identical
 * relationship collapses onto the same row and edge insertion is idempotent
 * under at-least-once transport, mirroring the mailbox's stable envelope id.
 *
 * The endpoints are serialized through {@link JSON.stringify} of a fixed-order
 * tuple rather than concatenated with a delimiter: `ThreadId`/`EnvironmentId`
 * are only trimmed non-empty strings and `WorkjetMeshWorkspaceId` permits `:`,
 * so any single-character separator could be forged into a collision. JSON
 * escaping makes the encoding unambiguous regardless of endpoint content.
 */
export const workjetDelegationEdgeId = (edge: {
  readonly kind: WorkjetDelegationEdge["kind"];
  readonly from: WorkjetDelegationRef;
  readonly to: WorkjetDelegationRef;
}): string =>
  JSON.stringify([
    edge.kind,
    edge.from.delegationId,
    edge.from.owner.workspaceId,
    edge.from.owner.environmentId,
    edge.from.owner.threadId,
    edge.to.delegationId,
    edge.to.owner.workspaceId,
    edge.to.owner.environmentId,
    edge.to.owner.threadId,
  ]);

// ===============================
// Errors
// ===============================

/**
 * A durable row that no longer decodes through its contract schema. Reported
 * as a typed failure with the table and row id, never as a crash, and never
 * carrying the offending payload — the plan forbids prompt or artifact
 * material in logs and traces.
 */
export class WorkjetMailboxStoreCorruptRowError extends Schema.TaggedErrorClass<WorkjetMailboxStoreCorruptRowError>()(
  "WorkjetMailboxStoreCorruptRowError",
  {
    table: Schema.Literals([
      "workjet_mailbox_outbox",
      "workjet_mailbox_inbox",
      "workjet_delegations",
      "workjet_delegation_edges",
      "workjet_mailbox_peer_keys",
    ]),
    rowId: Schema.String,
    issue: Schema.String,
  },
) {
  override get message(): string {
    return `Corrupt ${this.table} row ${this.rowId}: ${this.issue}`;
  }
}

/** Schema-aware runtime checks; `instanceof` is not the schema-aware narrowing. */
export const isWorkjetMailboxError = Schema.is(WorkjetMailboxError);
export const isWorkjetMailboxStoreCorruptRowError = Schema.is(WorkjetMailboxStoreCorruptRowError);

export type WorkjetMailboxStoreError =
  | PersistenceSqlError
  | WorkjetMailboxStoreCorruptRowError
  | WorkjetMailboxError;

// ===============================
// Records and outcomes
// ===============================

export const WorkjetOutboxState = Schema.Literals(["pending", "delivered", "dead"]);
export type WorkjetOutboxState = typeof WorkjetOutboxState.Type;

export interface WorkjetOutboxRecord {
  readonly envelopeId: WorkjetEnvelopeId;
  readonly envelope: WorkjetRoutingEnvelope;
  readonly payload: WorkjetMailboxPayload;
  readonly state: WorkjetOutboxState;
  readonly attemptCount: number;
  readonly nextAttemptAtMillis: number;
  readonly createdAtMillis: number;
  readonly expiresAtMillis: number;
  readonly deliveredAtMillis: number | null;
  readonly deadLetteredAtMillis: number | null;
}

export interface WorkjetInboxRecord {
  readonly envelopeId: WorkjetEnvelopeId;
  readonly envelope: WorkjetRoutingEnvelope;
  readonly payload: WorkjetMailboxPayload;
  readonly receivedAtMillis: number;
  readonly processedAtMillis: number | null;
  readonly expiresAtMillis: number;
}

export interface WorkjetDelegationRecord {
  readonly delegationId: WorkjetDelegationId;
  readonly delegation: WorkjetDelegation;
  readonly state: WorkjetDelegationState;
  readonly stateChangedAtMillis: number;
  readonly terminal: boolean;
}

/**
 * The orthogonal per-delegation accounting surface (migration 048): cumulative
 * usage and the approval-gate lifecycle. Independent of the state transition
 * table — a delegation's `state` says where it is in its lifecycle; this says
 * how much budget it has burned and whether a human has cleared it to run.
 */
/**
 * A mesh peer this machine has pinned. Ids and timestamps only — see
 * {@link MeshPeerDbRow}.
 */
export interface WorkjetMeshPeerRecord {
  readonly workspaceId: WorkjetMeshWorkspaceId;
  readonly environmentId: EnvironmentId;
  readonly firstSeenAtMillis: number;
  readonly sealedDeliveryReady: boolean;
}

/** A bounded page of peers plus whether the pin table holds more than the bound. */
export interface WorkjetMeshPeerPage {
  readonly peers: ReadonlyArray<WorkjetMeshPeerRecord>;
  readonly truncated: boolean;
}

export interface WorkjetDelegationAccounting {
  /** Cumulative tokens charged to the delegation. */
  readonly tokens: number;
  /** Cumulative cost in micro-currency (1e-6 of a unit). */
  readonly costMicros: number;
  readonly approvalState: WorkjetDelegationApprovalState;
}

/** New cumulative totals after a successful {@link WorkjetDelegationAccounting} charge. */
export interface WorkjetDelegationUsageTotals {
  readonly tokens: number;
  readonly costMicros: number;
}

export type WorkjetOutboundEnqueueOutcome =
  | { readonly _tag: "enqueued"; readonly envelopeId: WorkjetEnvelopeId }
  | { readonly _tag: "duplicate"; readonly envelopeId: WorkjetEnvelopeId };

/** Mirrors the non-`rejected` {@link WorkjetDeliveryReceipt} dispositions. */
export type WorkjetInboundRecordOutcome =
  | { readonly _tag: "accepted-new"; readonly envelopeId: WorkjetEnvelopeId }
  | { readonly _tag: "duplicate-ignored"; readonly envelopeId: WorkjetEnvelopeId }
  | { readonly _tag: "expired"; readonly envelopeId: WorkjetEnvelopeId };

export type WorkjetOutboundDeliveryOutcome =
  | { readonly _tag: "delivered"; readonly envelopeId: WorkjetEnvelopeId }
  | { readonly _tag: "not-pending"; readonly envelopeId: WorkjetEnvelopeId };

export type WorkjetOutboundAttemptOutcome =
  | {
      readonly _tag: "retry-scheduled";
      readonly envelopeId: WorkjetEnvelopeId;
      readonly attemptCount: number;
      readonly nextAttemptAtMillis: number;
    }
  | {
      readonly _tag: "dead-lettered";
      readonly envelopeId: WorkjetEnvelopeId;
      readonly attemptCount: number;
    }
  | { readonly _tag: "not-pending"; readonly envelopeId: WorkjetEnvelopeId };

export type WorkjetDelegationUpsertOutcome =
  | { readonly _tag: "inserted"; readonly delegationId: WorkjetDelegationId }
  | { readonly _tag: "updated"; readonly delegationId: WorkjetDelegationId };

/**
 * Outcome of finalizing a `running` delegation with its result.
 *
 * `finalized` is the fresh transition `running → completed|failed` that also
 * persisted the result JSON. `already-finalized` is the idempotent replay: the
 * row was terminal with a stored result, so the SAME persisted result is
 * returned rather than a second transition — a late or duplicate completion
 * therefore returns exactly what the first one did.
 */
export type WorkjetDelegationFinalizeOutcome =
  | {
      readonly _tag: "finalized";
      readonly record: WorkjetDelegationRecord;
      readonly result: WorkjetDelegationResult;
    }
  | {
      readonly _tag: "already-finalized";
      readonly record: WorkjetDelegationRecord;
      readonly result: WorkjetDelegationResult;
    };

/**
 * One row of a resilient by-state delegation scan.
 *
 * `record` is a row that decoded cleanly. `corrupt` is a row whose
 * `delegation_json` no longer decodes through the current contract schema —
 * the concrete face of "target version skew": a delegation whose stored shape
 * (schemaVersion, budget shape, …) this server can no longer read. It is
 * surfaced PER ROW rather than failing the whole batch, so one undecodable row
 * cannot abort a scan and silently strand every readable delegation behind it.
 * The offending payload is never carried, only its stable row id.
 */
export type WorkjetDelegationRowResult =
  | { readonly _tag: "record"; readonly record: WorkjetDelegationRecord }
  | { readonly _tag: "corrupt"; readonly rowId: string };

/**
 * One row of the CROSS-ENVIRONMENT result-redelivery scan (migration 049): a
 * terminal delegation that carries a persisted result whose return to the
 * source has neither succeeded nor been abandoned.
 *
 * `corrupt` mirrors {@link WorkjetDelegationRowResult}: a stored delegation the
 * current contract schema can no longer decode cannot have its result envelope
 * rebuilt, so it is surfaced by id and the caller marks it permanently failed
 * instead of re-reading it every cycle forever.
 */
export type WorkjetDelegationResultReturnRow =
  | {
      readonly _tag: "record";
      readonly record: WorkjetDelegationRecord;
      readonly result: WorkjetDelegationResult;
    }
  | { readonly _tag: "corrupt"; readonly delegationId: WorkjetDelegationId };

/** Idempotent-insertion outcome for a delegation-graph edge. */
export type WorkjetDelegationEdgeInsertOutcome =
  | { readonly _tag: "inserted"; readonly edgeId: string }
  | { readonly _tag: "duplicate"; readonly edgeId: string };

export interface WorkjetMailboxExpirySweep {
  readonly outboxDeadLettered: number;
  readonly inboxDropped: number;
  readonly delegationsExpired: number;
}

// ===============================
// Row schemas
// ===============================

const OutboxDbRow = Schema.Struct({
  envelopeId: WorkjetEnvelopeId,
  envelope: Schema.fromJsonString(WorkjetRoutingEnvelope),
  payload: Schema.fromJsonString(WorkjetMailboxPayload),
  state: WorkjetOutboxState,
  attemptCount: Schema.Int,
  nextAttemptAtMillis: Schema.Int,
  createdAtMillis: Schema.Int,
  expiresAtMillis: Schema.Int,
  deliveredAtMillis: Schema.NullOr(Schema.Int),
  deadLetteredAtMillis: Schema.NullOr(Schema.Int),
});

const InboxDbRow = Schema.Struct({
  envelopeId: WorkjetEnvelopeId,
  envelope: Schema.fromJsonString(WorkjetRoutingEnvelope),
  payload: Schema.fromJsonString(WorkjetMailboxPayload),
  receivedAtMillis: Schema.Int,
  processedAtMillis: Schema.NullOr(Schema.Int),
  expiresAtMillis: Schema.Int,
});

const DelegationDbRow = Schema.Struct({
  delegationId: WorkjetDelegationId,
  delegation: Schema.fromJsonString(WorkjetDelegation),
  state: WorkjetDelegationState,
  stateChangedAtMillis: Schema.Int,
  terminal: Schema.Int,
});

const DelegationEdgeDbRow = Schema.Struct({
  edgeId: Schema.String,
  edge: Schema.fromJsonString(WorkjetDelegationEdge),
});

/**
 * One trust-on-first-use peer pin (migrations 043/044) as the ROSTER sees it.
 *
 * The two key columns are absent on purpose: the roster read exists to answer
 * "which machines has this one exchanged mail with", and no caller of it ever
 * needs key material. `sealedDeliveryReady` is SQL's derived answer to "is an
 * encryption key pinned", which is the only key fact a recipient picker needs.
 */
const MeshPeerDbRow = Schema.Struct({
  workspaceId: WorkjetMeshWorkspaceId,
  environmentId: EnvironmentId,
  firstSeenAtMillis: Schema.Int,
  sealedDeliveryReady: Schema.Int,
});
const decodeMeshPeerDbRow = Schema.decodeUnknownEffect(MeshPeerDbRow);

const MESH_PEER_COLUMNS = `
  source_workspace_id AS "workspaceId",
  source_environment_id AS "environmentId",
  first_seen_at_ms AS "firstSeenAtMillis",
  CASE WHEN encryption_public_key IS NULL THEN 0 ELSE 1 END AS "sealedDeliveryReady"
`;

const decodeOutboxDbRow = Schema.decodeUnknownEffect(OutboxDbRow);
const decodeInboxDbRow = Schema.decodeUnknownEffect(InboxDbRow);
const decodeDelegationDbRow = Schema.decodeUnknownEffect(DelegationDbRow);
const decodeDelegationEdgeDbRow = Schema.decodeUnknownEffect(DelegationEdgeDbRow);

/** The accounting columns added by migration 048. */
const DelegationAccountingDbRow = Schema.Struct({
  tokens: Schema.Int,
  costMicros: Schema.Int,
  approvalState: WorkjetDelegationApprovalState,
});
const decodeDelegationAccountingDbRow = Schema.decodeUnknownEffect(DelegationAccountingDbRow);

const DELEGATION_ACCOUNTING_COLUMNS = `
  usage_tokens AS "tokens",
  usage_cost_micros AS "costMicros",
  approval_state AS "approvalState"
`;

const encodeRoutingEnvelopeJson = Schema.encodeEffect(
  Schema.fromJsonString(WorkjetRoutingEnvelope),
);
const encodeMailboxPayloadJson = Schema.encodeEffect(Schema.fromJsonString(WorkjetMailboxPayload));
const encodeDelegationJson = Schema.encodeEffect(Schema.fromJsonString(WorkjetDelegation));
const encodeDelegationResultJson = Schema.encodeEffect(
  Schema.fromJsonString(WorkjetDelegationResult),
);
const decodeDelegationResultJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkjetDelegationResult),
);
const encodeDelegationEdgeJson = Schema.encodeEffect(Schema.fromJsonString(WorkjetDelegationEdge));

const OUTBOX_COLUMNS = `
  envelope_id AS "envelopeId",
  routing_envelope_json AS "envelope",
  payload_json AS "payload",
  state AS "state",
  attempt_count AS "attemptCount",
  next_attempt_at_ms AS "nextAttemptAtMillis",
  created_at_ms AS "createdAtMillis",
  expires_at_ms AS "expiresAtMillis",
  delivered_at_ms AS "deliveredAtMillis",
  dead_lettered_at_ms AS "deadLetteredAtMillis"
`;

const INBOX_COLUMNS = `
  envelope_id AS "envelopeId",
  routing_envelope_json AS "envelope",
  payload_json AS "payload",
  received_at_ms AS "receivedAtMillis",
  processed_at_ms AS "processedAtMillis",
  expires_at_ms AS "expiresAtMillis"
`;

const DELEGATION_COLUMNS = `
  delegation_id AS "delegationId",
  delegation_json AS "delegation",
  state AS "state",
  state_changed_at_ms AS "stateChangedAtMillis",
  terminal AS "terminal"
`;

const DELEGATION_EDGE_COLUMNS = `
  edge_id AS "edgeId",
  edge_json AS "edge"
`;

// ===============================
// Service
// ===============================

export interface WorkjetMailboxStoreShape {
  readonly enqueueOutbound: (
    envelope: WorkjetRoutingEnvelope,
    payload: WorkjetMailboxPayload,
  ) => Effect.Effect<WorkjetOutboundEnqueueOutcome, WorkjetMailboxStoreError>;

  readonly recordInboundEnvelope: (
    envelope: WorkjetRoutingEnvelope,
    payload: WorkjetMailboxPayload,
    now: WorkjetMailboxTimestamp,
  ) => Effect.Effect<WorkjetInboundRecordOutcome, WorkjetMailboxStoreError>;

  readonly markInboundProcessed: (
    envelopeId: WorkjetEnvelopeId,
    processedAt: WorkjetMailboxTimestamp,
  ) => Effect.Effect<boolean, WorkjetMailboxStoreError>;

  readonly listUnprocessedInbound: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WorkjetInboxRecord>, WorkjetMailboxStoreError>;

  readonly getInbound: (
    envelopeId: WorkjetEnvelopeId,
  ) => Effect.Effect<Option.Option<WorkjetInboxRecord>, WorkjetMailboxStoreError>;

  readonly listPendingOutbound: (
    now: WorkjetMailboxTimestamp,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WorkjetOutboxRecord>, WorkjetMailboxStoreError>;

  readonly listOutboundByState: (
    state: WorkjetOutboxState,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WorkjetOutboxRecord>, WorkjetMailboxStoreError>;

  /**
   * The same by-state scan restricted to rows the reconciler has NOT yet marked
   * (`reconciled_at_ms IS NULL`, migration 049). A dead envelope is reconciled
   * exactly once instead of being re-read on every ten-second cycle for as long
   * as the row exists; a row pinned before the migration is simply unmarked, so
   * it is reconciled one last time and then marked.
   */
  readonly listUnreconciledOutboundByState: (
    state: WorkjetOutboxState,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WorkjetOutboxRecord>, WorkjetMailboxStoreError>;

  /**
   * Stamp an outbox row as reconciled. Returns `false` when the row is gone or
   * was already marked, which makes a repeated call harmless.
   */
  readonly markOutboundReconciled: (
    envelopeId: WorkjetEnvelopeId,
    reconciledAt: WorkjetMailboxTimestamp,
  ) => Effect.Effect<boolean, WorkjetMailboxStoreError>;

  readonly getOutbound: (
    envelopeId: WorkjetEnvelopeId,
  ) => Effect.Effect<Option.Option<WorkjetOutboxRecord>, WorkjetMailboxStoreError>;

  readonly markDelivered: (
    envelopeId: WorkjetEnvelopeId,
    deliveredAt: WorkjetMailboxTimestamp,
  ) => Effect.Effect<WorkjetOutboundDeliveryOutcome, WorkjetMailboxStoreError>;

  readonly recordAttempt: (
    envelopeId: WorkjetEnvelopeId,
    attemptedAt: WorkjetMailboxTimestamp,
  ) => Effect.Effect<WorkjetOutboundAttemptOutcome, WorkjetMailboxStoreError>;

  readonly upsertDelegation: (
    delegation: WorkjetDelegation,
  ) => Effect.Effect<WorkjetDelegationUpsertOutcome, WorkjetMailboxStoreError>;

  readonly transitionDelegationState: (
    delegationId: WorkjetDelegationId,
    from: WorkjetDelegationState,
    to: WorkjetDelegationState,
    changedAt: WorkjetMailboxTimestamp,
  ) => Effect.Effect<WorkjetDelegationRecord, WorkjetMailboxStoreError>;

  readonly getDelegation: (
    delegationId: WorkjetDelegationId,
  ) => Effect.Effect<Option.Option<WorkjetDelegationRecord>, WorkjetMailboxStoreError>;

  /**
   * Transition a `running` delegation to a terminal `completed`/`failed` and
   * persist its result in ONE transaction. Idempotent: a delegation already
   * finalized returns its stored result instead of transitioning again.
   */
  readonly finalizeDelegationResult: (input: {
    readonly delegationId: WorkjetDelegationId;
    readonly to: "completed" | "failed";
    readonly result: WorkjetDelegationResult;
    readonly changedAt: WorkjetMailboxTimestamp;
  }) => Effect.Effect<WorkjetDelegationFinalizeOutcome, WorkjetMailboxStoreError>;

  /** The persisted result of a finalized delegation, or `None`. */
  readonly getDelegationResult: (
    delegationId: WorkjetDelegationId,
  ) => Effect.Effect<Option.Option<WorkjetDelegationResult>, WorkjetMailboxStoreError>;

  /**
   * Terminal delegations whose persisted result was never successfully returned
   * to the source: `result_json IS NOT NULL` with both migration-049 markers
   * still NULL. This is the durable retry queue behind the reconciler's
   * result-redelivery scan — without it a transient enqueue failure lost the
   * return silently, because the result stayed on the row and nothing re-read
   * it. Oldest first, bounded by `limit`.
   */
  readonly listDelegationsPendingResultReturn: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WorkjetDelegationResultReturnRow>, WorkjetMailboxStoreError>;

  /**
   * Stamp a delegation's result as RETURNED (enqueued outbound, or handed to the
   * local source thread). Returns `false` when the row is gone or was already
   * stamped, so the scan can never enqueue the same result twice.
   */
  readonly markDelegationResultReturned: (
    delegationId: WorkjetDelegationId,
    returnedAt: WorkjetMailboxTimestamp,
  ) => Effect.Effect<boolean, WorkjetMailboxStoreError>;

  /**
   * Stamp a delegation's result return as PERMANENTLY failed — an encode or
   * signing rejection, or a delegation body this server can no longer decode.
   * The durable result stays on the row; only the retry stops.
   */
  readonly markDelegationResultReturnFailed: (
    delegationId: WorkjetDelegationId,
    failedAt: WorkjetMailboxTimestamp,
  ) => Effect.Effect<boolean, WorkjetMailboxStoreError>;

  readonly listDelegationsByState: (
    state: WorkjetDelegationState,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WorkjetDelegationRecord>, WorkjetMailboxStoreError>;

  /**
   * The same by-state scan as {@link listDelegationsByState}, but resilient to an
   * individual undecodable row: a row whose `delegation_json` no longer decodes
   * is returned as a `corrupt` marker instead of failing the whole `Effect`. The
   * reconciler relies on this so one version-skewed delegation cannot abort a
   * cycle or hide every readable row behind it. A genuine SQL failure (not a
   * decode failure) still fails the effect — that is a transient store outage,
   * not a corrupt row.
   */
  readonly listDelegationRowsByState: (
    state: WorkjetDelegationState,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WorkjetDelegationRowResult>, WorkjetMailboxStoreError>;

  /**
   * Re-point a still-pending delegation at a DIFFERENT target thread WITHOUT
   * changing its lifecycle state. Only a delegation in `delivered` or
   * `needs-input` may be reassigned; a terminal, `running`, or otherwise
   * in-flight delegation is refused with `invalid-state-transition`, so a task
   * that already began (or finished) can never be silently restarted on a second
   * thread. Because the target lives ONLY in the delegation body (there is no
   * separate target column and the delegation id is unchanged), the executor
   * subsequently dispatches to the new thread and only the new thread — the old
   * one is no longer addressed.
   */
  readonly reassignDelegation: (
    delegationId: WorkjetDelegationId,
    newTarget: WorkjetWorkerAddress,
    changedAt: WorkjetMailboxTimestamp,
  ) => Effect.Effect<WorkjetDelegationRecord, WorkjetMailboxStoreError>;

  /**
   * Transactionally accumulate token/cost usage onto a delegation, gating on its
   * budget BEFORE the durable write — exactly like the depth/round gates refuse
   * before the effect that would exceed them. Both deltas must be non-negative;
   * if either would push a cumulative total past its budget ceiling the whole
   * charge is refused with `token-budget-exceeded` / `cost-budget-exceeded` and
   * NOTHING is written. Otherwise the new cumulative totals are returned.
   */
  readonly recordDelegationUsage: (
    delegationId: WorkjetDelegationId,
    deltaTokens: number,
    deltaCostMicros: number,
  ) => Effect.Effect<WorkjetDelegationUsageTotals, WorkjetMailboxStoreError>;

  /**
   * The full accounting surface of a delegation (usage totals + approval state),
   * or `None` when the delegation does not exist.
   */
  readonly getDelegationAccounting: (
    delegationId: WorkjetDelegationId,
  ) => Effect.Effect<Option.Option<WorkjetDelegationAccounting>, WorkjetMailboxStoreError>;

  /**
   * Resolve a `pending` approval gate. `approved: true` moves it to `approved`
   * (the executor may then run the delegation); `approved: false` moves it to
   * `rejected` AND cancels the delegation (terminal `cancelled`) in ONE
   * transaction — a rejected escalation must never run. Refuses with
   * `invalid-state-transition` when the delegation is not `pending`.
   */
  readonly setDelegationApproval: (
    delegationId: WorkjetDelegationId,
    approved: boolean,
    changedAt: WorkjetMailboxTimestamp,
  ) => Effect.Effect<WorkjetDelegationAccounting, WorkjetMailboxStoreError>;

  /**
   * Whether the executor may transition a delegation into `running`. False while
   * an approval gate is `pending` or `rejected` (and for a missing delegation);
   * true for `not-required` and `approved`. The token/cost ceilings are enforced
   * at charge time, not here.
   */
  readonly isDelegationExecutable: (
    delegationId: WorkjetDelegationId,
  ) => Effect.Effect<boolean, WorkjetMailboxStoreError>;

  readonly expireOverdue: (
    now: WorkjetMailboxTimestamp,
  ) => Effect.Effect<WorkjetMailboxExpirySweep, WorkjetMailboxStoreError>;

  /**
   * Idempotently insert a typed delegation-graph edge. The edge id is derived
   * from `kind`/`from`/`to` ({@link workjetDelegationEdgeId}), so re-inserting
   * the identical relationship is reported as a `duplicate` and never writes a
   * second row.
   */
  readonly insertDelegationEdge: (
    edge: WorkjetDelegationEdge,
  ) => Effect.Effect<WorkjetDelegationEdgeInsertOutcome, WorkjetMailboxStoreError>;

  /**
   * Every edge touching a delegation, whether the delegation is the `from` or
   * the `to` endpoint, in deterministic creation order. Bounded by `limit`.
   */
  readonly listDelegationEdges: (
    delegationId: WorkjetDelegationId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WorkjetDelegationEdge>, WorkjetMailboxStoreError>;

  /**
   * Every mesh peer whose key this machine has pinned, oldest first, bounded by
   * `limit` (clamped into `[1, WORKJET_MESH_ROSTER_MAX_PEERS]` so no caller can
   * turn a picker list into an unbounded table scan). `truncated` reports that
   * the table holds more rows than were returned.
   *
   * This is a pure READ of the pin table. It never writes, never pins, and
   * never returns key material — a peer's signing and encryption keys stay
   * inside the transport that pinned them.
   */
  readonly listMeshPeers: (
    limit: number,
  ) => Effect.Effect<WorkjetMeshPeerPage, WorkjetMailboxStoreError>;
}

export class WorkjetMailboxStore extends Context.Service<
  WorkjetMailboxStore,
  WorkjetMailboxStoreShape
>()("t3/workjet/mailbox/WorkjetMailboxStore") {}

const sqlFailure = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

/** Input timestamps come from the contract schemas, so a parse failure is a malformed envelope. */
const toEpochMillis = (
  value: WorkjetMailboxTimestamp,
): Effect.Effect<number, WorkjetMailboxError> =>
  Option.match(DateTime.make(value), {
    onNone: () => Effect.fail(new WorkjetMailboxError({ reason: "malformed-envelope" })),
    onSome: (instant) => Effect.succeed(DateTime.toEpochMillis(instant)),
  });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const decodeOutbox = (row: unknown, rowId: string) =>
    decodeOutboxDbRow(row).pipe(
      Effect.mapError(
        (cause) =>
          new WorkjetMailboxStoreCorruptRowError({
            table: "workjet_mailbox_outbox",
            rowId,
            issue: cause.issue._tag,
          }),
      ),
      Effect.map(
        (decoded): WorkjetOutboxRecord => ({
          ...decoded,
          deliveredAtMillis: decoded.deliveredAtMillis,
          deadLetteredAtMillis: decoded.deadLetteredAtMillis,
        }),
      ),
    );

  const decodeInbox = (row: unknown, rowId: string) =>
    decodeInboxDbRow(row).pipe(
      Effect.mapError(
        (cause) =>
          new WorkjetMailboxStoreCorruptRowError({
            table: "workjet_mailbox_inbox",
            rowId,
            issue: cause.issue._tag,
          }),
      ),
      Effect.map((decoded): WorkjetInboxRecord => decoded),
    );

  const decodeDelegation = (row: unknown, rowId: string) =>
    decodeDelegationDbRow(row).pipe(
      Effect.mapError(
        (cause) =>
          new WorkjetMailboxStoreCorruptRowError({
            table: "workjet_delegations",
            rowId,
            issue: cause.issue._tag,
          }),
      ),
      Effect.map(
        (decoded): WorkjetDelegationRecord => ({
          delegationId: decoded.delegationId,
          delegation: decoded.delegation,
          state: decoded.state,
          stateChangedAtMillis: decoded.stateChangedAtMillis,
          terminal: decoded.terminal === 1,
        }),
      ),
    );

  const decodeDelegationEdge = (row: unknown, rowId: string) =>
    decodeDelegationEdgeDbRow(row).pipe(
      Effect.mapError(
        (cause) =>
          new WorkjetMailboxStoreCorruptRowError({
            table: "workjet_delegation_edges",
            rowId,
            issue: cause.issue._tag,
          }),
      ),
      Effect.map((decoded): WorkjetDelegationEdge => decoded.edge),
    );

  const rowIdOf = (row: unknown): string => {
    if (typeof row !== "object" || row === null) {
      return "<unknown>";
    }
    const candidate = row as {
      readonly envelopeId?: unknown;
      readonly delegationId?: unknown;
      readonly edgeId?: unknown;
      // A peer pin row is keyed by its source pair, not by an envelope id.
      readonly environmentId?: unknown;
    };
    if (typeof candidate.envelopeId === "string") {
      return candidate.envelopeId;
    }
    if (typeof candidate.delegationId === "string") {
      return candidate.delegationId;
    }
    if (typeof candidate.edgeId === "string") {
      return candidate.edgeId;
    }
    return typeof candidate.environmentId === "string" ? candidate.environmentId : "<unknown>";
  };

  const encodeEnvelopeAndPayload = (
    envelope: WorkjetRoutingEnvelope,
    payload: WorkjetMailboxPayload,
  ) =>
    Effect.all({
      envelopeJson: encodeRoutingEnvelopeJson(envelope),
      payloadJson: encodeMailboxPayloadJson(payload),
      createdAtMillis: toEpochMillis(envelope.createdAt),
      expiresAtMillis: toEpochMillis(envelope.expiresAt),
    }).pipe(
      Effect.mapError(
        (cause): WorkjetMailboxStoreError =>
          Schema.isSchemaError(cause)
            ? new WorkjetMailboxError({ reason: "malformed-envelope" })
            : cause,
      ),
    );

  const enqueueOutbound: WorkjetMailboxStoreShape["enqueueOutbound"] = (envelope, payload) =>
    Effect.gen(function* () {
      const encoded = yield* encodeEnvelopeAndPayload(envelope, payload);

      const inserted = yield* sql<{ readonly envelopeId: string }>`
        INSERT INTO workjet_mailbox_outbox (
          envelope_id,
          routing_envelope_json,
          payload_json,
          state,
          attempt_count,
          next_attempt_at_ms,
          created_at_ms,
          expires_at_ms,
          delivered_at_ms,
          dead_lettered_at_ms
        )
        VALUES (
          ${envelope.envelopeId},
          ${encoded.envelopeJson},
          ${encoded.payloadJson},
          'pending',
          0,
          ${encoded.createdAtMillis},
          ${encoded.createdAtMillis},
          ${encoded.expiresAtMillis},
          NULL,
          NULL
        )
        ON CONFLICT (envelope_id) DO NOTHING
        RETURNING envelope_id AS "envelopeId"
      `.pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.enqueueOutbound:insert")));

      return inserted.length > 0
        ? ({ _tag: "enqueued", envelopeId: envelope.envelopeId } as const)
        : ({ _tag: "duplicate", envelopeId: envelope.envelopeId } as const);
    });

  const recordInboundEnvelope: WorkjetMailboxStoreShape["recordInboundEnvelope"] = (
    envelope,
    payload,
    now,
  ) =>
    Effect.gen(function* () {
      const encoded = yield* encodeEnvelopeAndPayload(envelope, payload);
      const nowMillis = yield* toEpochMillis(now);

      // Expiry is checked BEFORE the deduplication key, so an envelope whose
      // row was already dropped by the expiry sweep can never be re-accepted.
      if (encoded.expiresAtMillis <= nowMillis) {
        return { _tag: "expired", envelopeId: envelope.envelopeId } as const;
      }

      const inserted = yield* sql<{ readonly envelopeId: string }>`
        INSERT INTO workjet_mailbox_inbox (
          envelope_id,
          routing_envelope_json,
          payload_json,
          received_at_ms,
          processed_at_ms,
          expires_at_ms
        )
        VALUES (
          ${envelope.envelopeId},
          ${encoded.envelopeJson},
          ${encoded.payloadJson},
          ${nowMillis},
          NULL,
          ${encoded.expiresAtMillis}
        )
        ON CONFLICT (envelope_id) DO NOTHING
        RETURNING envelope_id AS "envelopeId"
      `.pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.recordInboundEnvelope:insert")));

      return inserted.length > 0
        ? ({ _tag: "accepted-new", envelopeId: envelope.envelopeId } as const)
        : ({ _tag: "duplicate-ignored", envelopeId: envelope.envelopeId } as const);
    });

  const markInboundProcessed: WorkjetMailboxStoreShape["markInboundProcessed"] = (
    envelopeId,
    processedAt,
  ) =>
    Effect.gen(function* () {
      const processedAtMillis = yield* toEpochMillis(processedAt);
      const updated = yield* sql<{ readonly envelopeId: string }>`
        UPDATE workjet_mailbox_inbox
        SET processed_at_ms = ${processedAtMillis}
        WHERE envelope_id = ${envelopeId}
          AND processed_at_ms IS NULL
        RETURNING envelope_id AS "envelopeId"
      `.pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.markInboundProcessed:update")));
      return updated.length > 0;
    });

  const listUnprocessedInbound: WorkjetMailboxStoreShape["listUnprocessedInbound"] = (limit) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${INBOX_COLUMNS}
          FROM workjet_mailbox_inbox
          WHERE processed_at_ms IS NULL
          ORDER BY received_at_ms ASC, envelope_id ASC
          LIMIT ?
        `,
          [limit],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.listUnprocessedInbound:select")));
      return yield* Effect.forEach(rows, (row) => decodeInbox(row, rowIdOf(row)));
    });

  const getInbound: WorkjetMailboxStoreShape["getInbound"] = (envelopeId) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${INBOX_COLUMNS}
          FROM workjet_mailbox_inbox
          WHERE envelope_id = ?
        `,
          [envelopeId],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.getInbound:select")));
      const row = rows[0];
      return row === undefined
        ? Option.none<WorkjetInboxRecord>()
        : Option.some(yield* decodeInbox(row, rowIdOf(row)));
    });

  const listPendingOutbound: WorkjetMailboxStoreShape["listPendingOutbound"] = (now, limit) =>
    Effect.gen(function* () {
      const nowMillis = yield* toEpochMillis(now);
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${OUTBOX_COLUMNS}
          FROM workjet_mailbox_outbox
          WHERE state = 'pending'
            AND next_attempt_at_ms <= ?
            AND expires_at_ms > ?
          ORDER BY next_attempt_at_ms ASC, created_at_ms ASC, envelope_id ASC
          LIMIT ?
        `,
          [nowMillis, nowMillis, limit],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.listPendingOutbound:select")));
      return yield* Effect.forEach(rows, (row) => decodeOutbox(row, rowIdOf(row)));
    });

  const listOutboundByState: WorkjetMailboxStoreShape["listOutboundByState"] = (state, limit) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${OUTBOX_COLUMNS}
          FROM workjet_mailbox_outbox
          WHERE state = ?
          ORDER BY created_at_ms ASC, envelope_id ASC
          LIMIT ?
        `,
          [state, limit],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.listOutboundByState:select")));
      return yield* Effect.forEach(rows, (row) => decodeOutbox(row, rowIdOf(row)));
    });

  const listUnreconciledOutboundByState: WorkjetMailboxStoreShape["listUnreconciledOutboundByState"] =
    (state, limit) =>
      Effect.gen(function* () {
        const rows = yield* sql
          .unsafe(
            `
          SELECT ${OUTBOX_COLUMNS}
          FROM workjet_mailbox_outbox
          WHERE state = ?
            AND reconciled_at_ms IS NULL
          ORDER BY created_at_ms ASC, envelope_id ASC
          LIMIT ?
        `,
            [state, limit],
          )
          .pipe(
            Effect.mapError(
              sqlFailure("WorkjetMailboxStore.listUnreconciledOutboundByState:select"),
            ),
          );
        return yield* Effect.forEach(rows, (row) => decodeOutbox(row, rowIdOf(row)));
      });

  const markOutboundReconciled: WorkjetMailboxStoreShape["markOutboundReconciled"] = (
    envelopeId,
    reconciledAt,
  ) =>
    Effect.gen(function* () {
      const reconciledAtMillis = yield* toEpochMillis(reconciledAt);
      const updated = yield* sql<{ readonly envelopeId: string }>`
        UPDATE workjet_mailbox_outbox
        SET reconciled_at_ms = ${reconciledAtMillis}
        WHERE envelope_id = ${envelopeId}
          AND reconciled_at_ms IS NULL
        RETURNING envelope_id AS "envelopeId"
      `.pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.markOutboundReconciled:update")));
      return updated.length > 0;
    });

  const getOutbound: WorkjetMailboxStoreShape["getOutbound"] = (envelopeId) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${OUTBOX_COLUMNS}
          FROM workjet_mailbox_outbox
          WHERE envelope_id = ?
        `,
          [envelopeId],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.getOutbound:select")));
      const row = rows[0];
      return row === undefined
        ? Option.none<WorkjetOutboxRecord>()
        : Option.some(yield* decodeOutbox(row, rowIdOf(row)));
    });

  const markDelivered: WorkjetMailboxStoreShape["markDelivered"] = (envelopeId, deliveredAt) =>
    Effect.gen(function* () {
      const deliveredAtMillis = yield* toEpochMillis(deliveredAt);
      const updated = yield* sql<{ readonly envelopeId: string }>`
        UPDATE workjet_mailbox_outbox
        SET state = 'delivered',
            delivered_at_ms = ${deliveredAtMillis}
        WHERE envelope_id = ${envelopeId}
          AND state = 'pending'
        RETURNING envelope_id AS "envelopeId"
      `.pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.markDelivered:update")));

      return updated.length > 0
        ? ({ _tag: "delivered", envelopeId } as const)
        : ({ _tag: "not-pending", envelopeId } as const);
    });

  const recordAttempt: WorkjetMailboxStoreShape["recordAttempt"] = (envelopeId, attemptedAt) =>
    Effect.gen(function* () {
      const attemptedAtMillis = yield* toEpochMillis(attemptedAt);

      // Read-modify-write of attempt_count and the derived backoff: the read
      // and the write share one transaction so two concurrent transports
      // cannot both observe the same attempt count.
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly attemptCount: number;
            }>`
              SELECT attempt_count AS "attemptCount"
              FROM workjet_mailbox_outbox
              WHERE envelope_id = ${envelopeId}
                AND state = 'pending'
            `;
            const row = rows[0];
            if (row === undefined) {
              return { _tag: "not-pending", envelopeId } as const;
            }

            const attemptCount = row.attemptCount + 1;
            if (attemptCount >= WORKJET_MAILBOX_MAX_DELIVERY_ATTEMPTS) {
              yield* sql`
                UPDATE workjet_mailbox_outbox
                SET attempt_count = ${attemptCount},
                    state = 'dead',
                    dead_lettered_at_ms = ${attemptedAtMillis}
                WHERE envelope_id = ${envelopeId}
              `;
              return { _tag: "dead-lettered", envelopeId, attemptCount } as const;
            }

            const nextAttemptAtMillis =
              attemptedAtMillis + workjetMailboxBackoffMillis(attemptCount);
            yield* sql`
              UPDATE workjet_mailbox_outbox
              SET attempt_count = ${attemptCount},
                  next_attempt_at_ms = ${nextAttemptAtMillis}
              WHERE envelope_id = ${envelopeId}
            `;
            return {
              _tag: "retry-scheduled",
              envelopeId,
              attemptCount,
              nextAttemptAtMillis,
            } as const;
          }),
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.recordAttempt:transaction")));
    });

  const upsertDelegation: WorkjetMailboxStoreShape["upsertDelegation"] = (delegation) =>
    Effect.gen(function* () {
      const delegationJson = yield* encodeDelegationJson(delegation).pipe(
        Effect.mapError(() => new WorkjetMailboxError({ reason: "malformed-envelope" })),
      );
      const stateChangedAtMillis = yield* toEpochMillis(delegation.stateChangedAt);
      const expiresAtMillis = yield* toEpochMillis(delegation.budget.expiresAt);
      const terminal = isTerminalDelegationState(delegation.state) ? 1 : 0;
      // A delegation whose budget carries `requiresApproval` is born behind a
      // `pending` gate; the executor may not run it until a human approves. Any
      // other delegation needs no gate. This is set only at INSERT — the upsert
      // refreshes the BODY, never the orthogonal approval lifecycle.
      const initialApprovalState: WorkjetDelegationApprovalState =
        delegation.budget.requiresApproval === true ? "pending" : "not-required";

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              readonly state: string;
            }>`
              SELECT state AS "state"
              FROM workjet_delegations
              WHERE delegation_id = ${delegation.delegationId}
            `;
            const current = existing[0];

            if (current === undefined) {
              yield* sql`
                INSERT INTO workjet_delegations (
                  delegation_id,
                  delegation_json,
                  state,
                  state_changed_at_ms,
                  terminal,
                  expires_at_ms,
                  approval_state
                )
                VALUES (
                  ${delegation.delegationId},
                  ${delegationJson},
                  ${delegation.state},
                  ${stateChangedAtMillis},
                  ${terminal},
                  ${expiresAtMillis},
                  ${initialApprovalState}
                )
              `;
              return { _tag: "inserted", delegationId: delegation.delegationId } as const;
            }

            // The upsert refreshes the delegation BODY only. A state change is
            // the transition API's job, so re-storing a delegation with a
            // different state — or touching a terminal one at all — is refused
            // rather than silently bypassing the transition table.
            if (current.state !== delegation.state) {
              return yield* new WorkjetMailboxError({ reason: "invalid-state-transition" });
            }

            yield* sql`
              UPDATE workjet_delegations
              SET delegation_json = ${delegationJson},
                  state_changed_at_ms = ${stateChangedAtMillis},
                  terminal = ${terminal},
                  expires_at_ms = ${expiresAtMillis}
              WHERE delegation_id = ${delegation.delegationId}
            `;
            return { _tag: "updated", delegationId: delegation.delegationId } as const;
          }),
        )
        .pipe(
          Effect.mapError(
            (cause): WorkjetMailboxStoreError =>
              isWorkjetMailboxError(cause)
                ? cause
                : new PersistenceSqlError({
                    operation: "WorkjetMailboxStore.upsertDelegation:transaction",
                    cause,
                  }),
          ),
        );
    });

  const transitionDelegationState: WorkjetMailboxStoreShape["transitionDelegationState"] = (
    delegationId,
    from,
    to,
    changedAt,
  ) =>
    Effect.gen(function* () {
      const changedAtMillis = yield* toEpochMillis(changedAt);

      // The legality check and the write are ONE transaction: no TOCTOU window
      // in which a concurrent transition could invalidate the observed state.
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql.unsafe(
              `
              SELECT ${DELEGATION_COLUMNS}
              FROM workjet_delegations
              WHERE delegation_id = ?
            `,
              [delegationId],
            );
            const row = rows[0];
            if (row === undefined) {
              return yield* new WorkjetMailboxError({ reason: "unknown-target" });
            }

            const record = yield* decodeDelegation(row, rowIdOf(row));

            if (record.state !== from || !isLegalDelegationTransition(from, to)) {
              return yield* new WorkjetMailboxError({ reason: "invalid-state-transition" });
            }

            const updatedDelegation: WorkjetDelegation = {
              ...record.delegation,
              state: to,
              stateChangedAt: changedAt,
            };
            const delegationJson = yield* encodeDelegationJson(updatedDelegation).pipe(
              Effect.mapError(() => new WorkjetMailboxError({ reason: "malformed-envelope" })),
            );
            const terminal = isTerminalDelegationState(to) ? 1 : 0;

            yield* sql`
              UPDATE workjet_delegations
              SET delegation_json = ${delegationJson},
                  state = ${to},
                  state_changed_at_ms = ${changedAtMillis},
                  terminal = ${terminal}
              WHERE delegation_id = ${delegationId}
                AND state = ${from}
            `;

            return {
              delegationId,
              delegation: updatedDelegation,
              state: to,
              stateChangedAtMillis: changedAtMillis,
              terminal: terminal === 1,
            } satisfies WorkjetDelegationRecord;
          }),
        )
        .pipe(
          Effect.mapError(
            (cause): WorkjetMailboxStoreError =>
              isWorkjetMailboxError(cause) || isWorkjetMailboxStoreCorruptRowError(cause)
                ? cause
                : new PersistenceSqlError({
                    operation: "WorkjetMailboxStore.transitionDelegationState:transaction",
                    cause,
                  }),
          ),
        );
    });

  const getDelegation: WorkjetMailboxStoreShape["getDelegation"] = (delegationId) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${DELEGATION_COLUMNS}
          FROM workjet_delegations
          WHERE delegation_id = ?
        `,
          [delegationId],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.getDelegation:select")));
      const row = rows[0];
      return row === undefined
        ? Option.none<WorkjetDelegationRecord>()
        : Option.some(yield* decodeDelegation(row, rowIdOf(row)));
    });

  const finalizeDelegationResult: WorkjetMailboxStoreShape["finalizeDelegationResult"] = (input) =>
    Effect.gen(function* () {
      const changedAtMillis = yield* toEpochMillis(input.changedAt);
      const resultJson = yield* encodeDelegationResultJson(input.result).pipe(
        Effect.mapError(() => new WorkjetMailboxError({ reason: "malformed-envelope" })),
      );

      // Legality, the terminal write, and the result persistence share ONE
      // transaction: a concurrent cancellation or expiry cannot slip between the
      // observed state and the finalize, and the result column never diverges
      // from the state it describes.
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql.unsafe(
              `
              SELECT ${DELEGATION_COLUMNS}, result_json AS "resultJson"
              FROM workjet_delegations
              WHERE delegation_id = ?
            `,
              [input.delegationId],
            );
            const row = rows[0];
            if (row === undefined) {
              return yield* new WorkjetMailboxError({ reason: "unknown-target" });
            }
            const record = yield* decodeDelegation(row, rowIdOf(row));
            const existingResultJson = (row as { readonly resultJson?: unknown }).resultJson;

            // A delegation already finalized returns its STORED result — the
            // idempotent replay a late or duplicate completion must observe.
            if (record.terminal) {
              if (typeof existingResultJson === "string") {
                const storedResult = yield* decodeDelegationResultJson(existingResultJson).pipe(
                  Effect.mapError(
                    () =>
                      new WorkjetMailboxStoreCorruptRowError({
                        table: "workjet_delegations",
                        rowId: input.delegationId,
                        issue: "result_json",
                      }),
                  ),
                );
                return {
                  _tag: "already-finalized",
                  record,
                  result: storedResult,
                } as const;
              }
              // Terminal by another path (cancelled/expired/refused) with no
              // stored result: there is no result to return and the state is
              // immutable, so the finalize is refused rather than inventing one.
              return yield* new WorkjetMailboxError({ reason: "invalid-state-transition" });
            }

            if (record.state !== "running" || !isLegalDelegationTransition("running", input.to)) {
              return yield* new WorkjetMailboxError({ reason: "invalid-state-transition" });
            }

            const updatedDelegation: WorkjetDelegation = {
              ...record.delegation,
              state: input.to,
              stateChangedAt: input.changedAt,
            };
            const delegationJson = yield* encodeDelegationJson(updatedDelegation).pipe(
              Effect.mapError(() => new WorkjetMailboxError({ reason: "malformed-envelope" })),
            );

            yield* sql`
              UPDATE workjet_delegations
              SET delegation_json = ${delegationJson},
                  state = ${input.to},
                  state_changed_at_ms = ${changedAtMillis},
                  terminal = 1,
                  result_json = ${resultJson}
              WHERE delegation_id = ${input.delegationId}
                AND state = 'running'
            `;

            return {
              _tag: "finalized",
              record: {
                delegationId: input.delegationId,
                delegation: updatedDelegation,
                state: input.to,
                stateChangedAtMillis: changedAtMillis,
                terminal: true,
              } satisfies WorkjetDelegationRecord,
              result: input.result,
            } as const;
          }),
        )
        .pipe(
          Effect.mapError(
            (cause): WorkjetMailboxStoreError =>
              isWorkjetMailboxError(cause) || isWorkjetMailboxStoreCorruptRowError(cause)
                ? cause
                : new PersistenceSqlError({
                    operation: "WorkjetMailboxStore.finalizeDelegationResult:transaction",
                    cause,
                  }),
          ),
        );
    });

  const getDelegationResult: WorkjetMailboxStoreShape["getDelegationResult"] = (delegationId) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT result_json AS "resultJson"
          FROM workjet_delegations
          WHERE delegation_id = ?
        `,
          [delegationId],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.getDelegationResult:select")));
      const row = rows[0] as { readonly resultJson?: unknown } | undefined;
      if (row === undefined || typeof row.resultJson !== "string") {
        return Option.none<WorkjetDelegationResult>();
      }
      const result = yield* decodeDelegationResultJson(row.resultJson).pipe(
        Effect.mapError(
          () =>
            new WorkjetMailboxStoreCorruptRowError({
              table: "workjet_delegations",
              rowId: delegationId,
              issue: "result_json",
            }),
        ),
      );
      return Option.some(result);
    });

  const listDelegationsPendingResultReturn: WorkjetMailboxStoreShape["listDelegationsPendingResultReturn"] =
    (limit) =>
      Effect.gen(function* () {
        const rows = yield* sql
          .unsafe(
            `
          SELECT ${DELEGATION_COLUMNS}, result_json AS "resultJson"
          FROM workjet_delegations
          WHERE terminal = 1
            AND result_json IS NOT NULL
            AND result_enqueued_at_ms IS NULL
            AND result_enqueue_failed_at_ms IS NULL
          ORDER BY state_changed_at_ms ASC, delegation_id ASC
          LIMIT ?
        `,
            [limit],
          )
          .pipe(
            Effect.mapError(
              sqlFailure("WorkjetMailboxStore.listDelegationsPendingResultReturn:select"),
            ),
          );
        return yield* Effect.forEach(rows, (row) => {
          const rowId = rowIdOf(row);
          const resultJson = (row as { readonly resultJson?: unknown }).resultJson;
          // Both the delegation body and the stored result must decode: the
          // retry rebuilds a signed envelope from the former and carries the
          // latter. Either failing is the same permanent, per-row fault the
          // caller marks — never a reason to abort the batch.
          return Effect.all({
            record: decodeDelegation(row, rowId),
            result:
              typeof resultJson === "string"
                ? decodeDelegationResultJson(resultJson).pipe(
                    Effect.mapError(
                      () =>
                        new WorkjetMailboxStoreCorruptRowError({
                          table: "workjet_delegations",
                          rowId,
                          issue: "result_json",
                        }),
                    ),
                  )
                : Effect.fail(
                    new WorkjetMailboxStoreCorruptRowError({
                      table: "workjet_delegations",
                      rowId,
                      issue: "result_json",
                    }),
                  ),
          }).pipe(
            Effect.map(({ record, result }) => ({ _tag: "record", record, result }) as const),
            Effect.catch(() =>
              Effect.succeed({
                _tag: "corrupt",
                delegationId: WorkjetDelegationId.make(rowId),
              } as const),
            ),
          );
        });
      });

  const markDelegationResultReturned: WorkjetMailboxStoreShape["markDelegationResultReturned"] = (
    delegationId,
    returnedAt,
  ) =>
    Effect.gen(function* () {
      const returnedAtMillis = yield* toEpochMillis(returnedAt);
      const updated = yield* sql<{ readonly delegationId: string }>`
        UPDATE workjet_delegations
        SET result_enqueued_at_ms = ${returnedAtMillis}
        WHERE delegation_id = ${delegationId}
          AND result_enqueued_at_ms IS NULL
        RETURNING delegation_id AS "delegationId"
      `.pipe(
        Effect.mapError(sqlFailure("WorkjetMailboxStore.markDelegationResultReturned:update")),
      );
      return updated.length > 0;
    });

  const markDelegationResultReturnFailed: WorkjetMailboxStoreShape["markDelegationResultReturnFailed"] =
    (delegationId, failedAt) =>
      Effect.gen(function* () {
        const failedAtMillis = yield* toEpochMillis(failedAt);
        const updated = yield* sql<{ readonly delegationId: string }>`
        UPDATE workjet_delegations
        SET result_enqueue_failed_at_ms = ${failedAtMillis}
        WHERE delegation_id = ${delegationId}
          AND result_enqueue_failed_at_ms IS NULL
        RETURNING delegation_id AS "delegationId"
      `.pipe(
          Effect.mapError(
            sqlFailure("WorkjetMailboxStore.markDelegationResultReturnFailed:update"),
          ),
        );
        return updated.length > 0;
      });

  const listDelegationsByState: WorkjetMailboxStoreShape["listDelegationsByState"] = (
    state,
    limit,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${DELEGATION_COLUMNS}
          FROM workjet_delegations
          WHERE state = ?
          ORDER BY state_changed_at_ms ASC, delegation_id ASC
          LIMIT ?
        `,
          [state, limit],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.listDelegationsByState:select")));
      return yield* Effect.forEach(rows, (row) => decodeDelegation(row, rowIdOf(row)));
    });

  const listDelegationRowsByState: WorkjetMailboxStoreShape["listDelegationRowsByState"] = (
    state,
    limit,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${DELEGATION_COLUMNS}
          FROM workjet_delegations
          WHERE state = ?
          ORDER BY state_changed_at_ms ASC, delegation_id ASC
          LIMIT ?
        `,
          [state, limit],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.listDelegationRowsByState:select")));
      return yield* Effect.forEach(rows, (row) => {
        const rowId = rowIdOf(row);
        // A decode failure is the corrupt/version-skewed row we tolerate per-row;
        // decodeDelegation only ever fails with WorkjetMailboxStoreCorruptRowError,
        // so catching it narrows to exactly that and never swallows a defect.
        return decodeDelegation(row, rowId).pipe(
          Effect.map((record) => ({ _tag: "record", record }) as const),
          Effect.catch(() => Effect.succeed({ _tag: "corrupt", rowId } as const)),
        );
      });
    });

  const reassignDelegation: WorkjetMailboxStoreShape["reassignDelegation"] = (
    delegationId,
    newTarget,
    changedAt,
  ) =>
    Effect.gen(function* () {
      const changedAtMillis = yield* toEpochMillis(changedAt);

      // The read, the state gate, and the write share ONE transaction, exactly
      // like transitionDelegationState: a concurrent transition cannot slip
      // between observing `delivered`/`needs-input` and rewriting the target.
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql.unsafe(
              `
              SELECT ${DELEGATION_COLUMNS}
              FROM workjet_delegations
              WHERE delegation_id = ?
            `,
              [delegationId],
            );
            const row = rows[0];
            if (row === undefined) {
              return yield* new WorkjetMailboxError({ reason: "unknown-target" });
            }
            const record = yield* decodeDelegation(row, rowIdOf(row));

            // Reassignment is only meaningful while the task has not begun. A
            // terminal, running, queued, accepted, or in-review delegation is
            // refused so work in flight is never silently moved or restarted.
            if (record.state !== "delivered" && record.state !== "needs-input") {
              return yield* new WorkjetMailboxError({ reason: "invalid-state-transition" });
            }

            const reassignedDelegation: WorkjetDelegation = {
              ...record.delegation,
              target: newTarget,
              stateChangedAt: changedAt,
            };
            const delegationJson = yield* encodeDelegationJson(reassignedDelegation).pipe(
              Effect.mapError(() => new WorkjetMailboxError({ reason: "malformed-envelope" })),
            );

            // State and terminal flag are deliberately unchanged: reassignment
            // moves the target, never the lifecycle position.
            yield* sql`
              UPDATE workjet_delegations
              SET delegation_json = ${delegationJson},
                  state_changed_at_ms = ${changedAtMillis}
              WHERE delegation_id = ${delegationId}
                AND state = ${record.state}
            `;

            return {
              delegationId,
              delegation: reassignedDelegation,
              state: record.state,
              stateChangedAtMillis: changedAtMillis,
              terminal: false,
            } satisfies WorkjetDelegationRecord;
          }),
        )
        .pipe(
          Effect.mapError(
            (cause): WorkjetMailboxStoreError =>
              isWorkjetMailboxError(cause) || isWorkjetMailboxStoreCorruptRowError(cause)
                ? cause
                : new PersistenceSqlError({
                    operation: "WorkjetMailboxStore.reassignDelegation:transaction",
                    cause,
                  }),
          ),
        );
    });

  const decodeAccounting = (row: unknown, rowId: string) =>
    decodeDelegationAccountingDbRow(row).pipe(
      Effect.mapError(
        (cause) =>
          new WorkjetMailboxStoreCorruptRowError({
            table: "workjet_delegations",
            rowId,
            issue: cause.issue._tag,
          }),
      ),
      Effect.map(
        (decoded): WorkjetDelegationAccounting => ({
          tokens: decoded.tokens,
          costMicros: decoded.costMicros,
          approvalState: decoded.approvalState,
        }),
      ),
    );

  const recordDelegationUsage: WorkjetMailboxStoreShape["recordDelegationUsage"] = (
    delegationId,
    deltaTokens,
    deltaCostMicros,
  ) =>
    Effect.gen(function* () {
      // A negative delta could silently walk a total back under a ceiling that
      // was already crossed — never a legitimate "charge". Reject it as a
      // malformed request rather than corrupting the accounting.
      if (
        !Number.isSafeInteger(deltaTokens) ||
        !Number.isSafeInteger(deltaCostMicros) ||
        deltaTokens < 0 ||
        deltaCostMicros < 0
      ) {
        return yield* new WorkjetMailboxError({ reason: "malformed-envelope" });
      }

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // The budget lives in the delegation body; the running totals live in
            // the orthogonal columns. Reading both under one transaction closes
            // the TOCTOU window a concurrent charge would otherwise open.
            const rows = yield* sql.unsafe(
              `
              SELECT ${DELEGATION_COLUMNS}, ${DELEGATION_ACCOUNTING_COLUMNS}
              FROM workjet_delegations
              WHERE delegation_id = ?
            `,
              [delegationId],
            );
            const row = rows[0];
            if (row === undefined) {
              return yield* new WorkjetMailboxError({ reason: "unknown-target" });
            }
            const record = yield* decodeDelegation(row, rowIdOf(row));
            const accounting = yield* decodeAccounting(row, rowIdOf(row));

            const budget = record.delegation.budget;
            const nextTokens = accounting.tokens + deltaTokens;
            const nextCostMicros = accounting.costMicros + deltaCostMicros;

            // Gate BEFORE the durable write: an accumulation that would cross a
            // ceiling is refused and nothing is persisted, exactly like the
            // depth/round gates refuse before their effect.
            if (budget.maxTokens !== undefined && nextTokens > budget.maxTokens) {
              return yield* new WorkjetMailboxError({ reason: "token-budget-exceeded" });
            }
            if (budget.maxCostMicros !== undefined && nextCostMicros > budget.maxCostMicros) {
              return yield* new WorkjetMailboxError({ reason: "cost-budget-exceeded" });
            }

            yield* sql`
              UPDATE workjet_delegations
              SET usage_tokens = ${nextTokens},
                  usage_cost_micros = ${nextCostMicros}
              WHERE delegation_id = ${delegationId}
            `;

            return {
              tokens: nextTokens,
              costMicros: nextCostMicros,
            } satisfies WorkjetDelegationUsageTotals;
          }),
        )
        .pipe(
          Effect.mapError(
            (cause): WorkjetMailboxStoreError =>
              isWorkjetMailboxError(cause) || isWorkjetMailboxStoreCorruptRowError(cause)
                ? cause
                : new PersistenceSqlError({
                    operation: "WorkjetMailboxStore.recordDelegationUsage:transaction",
                    cause,
                  }),
          ),
        );
    });

  const getDelegationAccounting: WorkjetMailboxStoreShape["getDelegationAccounting"] = (
    delegationId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${DELEGATION_ACCOUNTING_COLUMNS}
          FROM workjet_delegations
          WHERE delegation_id = ?
        `,
          [delegationId],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.getDelegationAccounting:select")));
      const row = rows[0];
      return row === undefined
        ? Option.none<WorkjetDelegationAccounting>()
        : Option.some(yield* decodeAccounting(row, delegationId));
    });

  const setDelegationApproval: WorkjetMailboxStoreShape["setDelegationApproval"] = (
    delegationId,
    approved,
    changedAt,
  ) =>
    Effect.gen(function* () {
      const changedAtMillis = yield* toEpochMillis(changedAt);

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql.unsafe(
              `
              SELECT ${DELEGATION_COLUMNS}, ${DELEGATION_ACCOUNTING_COLUMNS}
              FROM workjet_delegations
              WHERE delegation_id = ?
            `,
              [delegationId],
            );
            const row = rows[0];
            if (row === undefined) {
              return yield* new WorkjetMailboxError({ reason: "unknown-target" });
            }
            const record = yield* decodeDelegation(row, rowIdOf(row));
            const accounting = yield* decodeAccounting(row, rowIdOf(row));

            // Only a `pending` gate can be resolved. Approving a `not-required`
            // delegation or re-deciding a settled one is an illegal transition,
            // not a silent no-op.
            if (accounting.approvalState !== "pending") {
              return yield* new WorkjetMailboxError({ reason: "invalid-state-transition" });
            }

            const nextApproval: WorkjetDelegationApprovalState = approved ? "approved" : "rejected";

            if (approved) {
              yield* sql`
                UPDATE workjet_delegations
                SET approval_state = ${nextApproval}
                WHERE delegation_id = ${delegationId}
              `;
              return { ...accounting, approvalState: nextApproval };
            }

            // Rejection is terminal: the gate becomes `rejected` AND the
            // delegation is cancelled in the SAME transaction, so a rejected
            // escalation can never be picked up and run. The transition must be
            // legal from the delegation's current (non-terminal) state.
            if (record.terminal || !isLegalDelegationTransition(record.state, "cancelled")) {
              return yield* new WorkjetMailboxError({ reason: "invalid-state-transition" });
            }
            const cancelledDelegation: WorkjetDelegation = {
              ...record.delegation,
              state: "cancelled",
              stateChangedAt: changedAt,
            };
            const delegationJson = yield* encodeDelegationJson(cancelledDelegation).pipe(
              Effect.mapError(() => new WorkjetMailboxError({ reason: "malformed-envelope" })),
            );
            yield* sql`
              UPDATE workjet_delegations
              SET approval_state = ${nextApproval},
                  delegation_json = ${delegationJson},
                  state = 'cancelled',
                  state_changed_at_ms = ${changedAtMillis},
                  terminal = 1
              WHERE delegation_id = ${delegationId}
            `;
            return { ...accounting, approvalState: nextApproval };
          }),
        )
        .pipe(
          Effect.mapError(
            (cause): WorkjetMailboxStoreError =>
              isWorkjetMailboxError(cause) || isWorkjetMailboxStoreCorruptRowError(cause)
                ? cause
                : new PersistenceSqlError({
                    operation: "WorkjetMailboxStore.setDelegationApproval:transaction",
                    cause,
                  }),
          ),
        );
    });

  const isDelegationExecutable: WorkjetMailboxStoreShape["isDelegationExecutable"] = (
    delegationId,
  ) =>
    getDelegationAccounting(delegationId).pipe(
      Effect.map(
        Option.match({
          // A delegation that is not here cannot be run here.
          onNone: () => false,
          onSome: (accounting) =>
            accounting.approvalState === "not-required" || accounting.approvalState === "approved",
        }),
      ),
    );

  const expireOverdue: WorkjetMailboxStoreShape["expireOverdue"] = (now) =>
    Effect.gen(function* () {
      const nowMillis = yield* toEpochMillis(now);

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Overdue pending outbox rows become dead letters rather than
            // disappearing: the plan requires a queryable dead-letter state.
            const deadLettered = yield* sql<{ readonly envelopeId: string }>`
              UPDATE workjet_mailbox_outbox
              SET state = 'dead',
                  dead_lettered_at_ms = ${nowMillis}
              WHERE state = 'pending'
                AND expires_at_ms <= ${nowMillis}
              RETURNING envelope_id AS "envelopeId"
            `;

            // Overdue inbox rows are dropped. The deduplication guarantee is
            // preserved because recordInboundEnvelope refuses an expired
            // envelope before it looks at the deduplication key.
            const dropped = yield* sql<{ readonly envelopeId: string }>`
              DELETE FROM workjet_mailbox_inbox
              WHERE expires_at_ms <= ${nowMillis}
              RETURNING envelope_id AS "envelopeId"
            `;

            // Non-terminal delegations past their BUDGET expiry become the
            // terminal `expired` state. The stored delegation JSON is rewritten
            // in the same statement so the column and the contract value never
            // diverge.
            const overdue = yield* sql.unsafe(
              `
              SELECT ${DELEGATION_COLUMNS}
              FROM workjet_delegations
              WHERE terminal = 0
                AND expires_at_ms <= ?
            `,
              [nowMillis],
            );

            const expiredDelegations = yield* Effect.forEach(overdue, (row) =>
              Effect.gen(function* () {
                const record = yield* decodeDelegation(row, rowIdOf(row));
                const updatedDelegation: WorkjetDelegation = {
                  ...record.delegation,
                  state: "expired",
                  stateChangedAt: now,
                };
                const delegationJson = yield* encodeDelegationJson(updatedDelegation).pipe(
                  Effect.mapError(() => new WorkjetMailboxError({ reason: "malformed-envelope" })),
                );
                yield* sql`
                  UPDATE workjet_delegations
                  SET delegation_json = ${delegationJson},
                      state = 'expired',
                      state_changed_at_ms = ${nowMillis},
                      terminal = 1
                  WHERE delegation_id = ${record.delegationId}
                `;
                return record.delegationId;
              }),
            );

            return {
              outboxDeadLettered: deadLettered.length,
              inboxDropped: dropped.length,
              delegationsExpired: expiredDelegations.length,
            } satisfies WorkjetMailboxExpirySweep;
          }),
        )
        .pipe(
          Effect.mapError(
            (cause): WorkjetMailboxStoreError =>
              isWorkjetMailboxError(cause) || isWorkjetMailboxStoreCorruptRowError(cause)
                ? cause
                : new PersistenceSqlError({
                    operation: "WorkjetMailboxStore.expireOverdue:transaction",
                    cause,
                  }),
          ),
        );
    });

  const insertDelegationEdge: WorkjetMailboxStoreShape["insertDelegationEdge"] = (edge) =>
    Effect.gen(function* () {
      const edgeId = workjetDelegationEdgeId(edge);
      const edgeJson = yield* encodeDelegationEdgeJson(edge).pipe(
        Effect.mapError(() => new WorkjetMailboxError({ reason: "malformed-envelope" })),
      );
      const createdAtMillis = yield* toEpochMillis(edge.createdAt);

      const inserted = yield* sql<{ readonly edgeId: string }>`
        INSERT INTO workjet_delegation_edges (
          edge_id,
          kind,
          from_delegation_id,
          to_delegation_id,
          edge_json,
          depth,
          created_at_ms
        )
        VALUES (
          ${edgeId},
          ${edge.kind},
          ${edge.from.delegationId},
          ${edge.to.delegationId},
          ${edgeJson},
          ${edge.depth},
          ${createdAtMillis}
        )
        ON CONFLICT (edge_id) DO NOTHING
        RETURNING edge_id AS "edgeId"
      `.pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.insertDelegationEdge:insert")));

      return inserted.length > 0
        ? ({ _tag: "inserted", edgeId } as const)
        : ({ _tag: "duplicate", edgeId } as const);
    });

  const listDelegationEdges: WorkjetMailboxStoreShape["listDelegationEdges"] = (
    delegationId,
    limit,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${DELEGATION_EDGE_COLUMNS}
          FROM workjet_delegation_edges
          WHERE from_delegation_id = ? OR to_delegation_id = ?
          ORDER BY created_at_ms ASC, edge_id ASC
          LIMIT ?
        `,
          [delegationId, delegationId, limit],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.listDelegationEdges:select")));
      return yield* Effect.forEach(rows, (row) => decodeDelegationEdge(row, rowIdOf(row)));
    });

  const listMeshPeers: WorkjetMailboxStoreShape["listMeshPeers"] = (limit) =>
    Effect.gen(function* () {
      const bounded = Math.min(
        WORKJET_MESH_ROSTER_MAX_PEERS,
        Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 1),
      );
      // One row beyond the bound is fetched purely to answer `truncated`
      // without a second COUNT query, and is never returned.
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${MESH_PEER_COLUMNS}
          FROM workjet_mailbox_peer_keys
          ORDER BY first_seen_at_ms ASC, source_environment_id ASC
          LIMIT ?
        `,
          [bounded + 1],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetMailboxStore.listMeshPeers:select")));

      const page = rows.slice(0, bounded);
      const peers = yield* Effect.forEach(page, (row) =>
        decodeMeshPeerDbRow(row).pipe(
          Effect.mapError(
            (cause) =>
              new WorkjetMailboxStoreCorruptRowError({
                table: "workjet_mailbox_peer_keys",
                rowId: rowIdOf(row),
                issue: cause.issue._tag,
              }),
          ),
          Effect.map(
            (decoded): WorkjetMeshPeerRecord => ({
              workspaceId: decoded.workspaceId,
              environmentId: decoded.environmentId,
              firstSeenAtMillis: decoded.firstSeenAtMillis,
              sealedDeliveryReady: decoded.sealedDeliveryReady === 1,
            }),
          ),
        ),
      );
      return { peers, truncated: rows.length > bounded } satisfies WorkjetMeshPeerPage;
    });

  return {
    enqueueOutbound,
    recordInboundEnvelope,
    markInboundProcessed,
    listUnprocessedInbound,
    getInbound,
    listPendingOutbound,
    listOutboundByState,
    listUnreconciledOutboundByState,
    markOutboundReconciled,
    getOutbound,
    markDelivered,
    recordAttempt,
    upsertDelegation,
    transitionDelegationState,
    getDelegation,
    finalizeDelegationResult,
    getDelegationResult,
    listDelegationsPendingResultReturn,
    markDelegationResultReturned,
    markDelegationResultReturnFailed,
    listDelegationsByState,
    listDelegationRowsByState,
    reassignDelegation,
    recordDelegationUsage,
    getDelegationAccounting,
    setDelegationApproval,
    isDelegationExecutable,
    expireOverdue,
    insertDelegationEdge,
    listDelegationEdges,
    listMeshPeers,
  } satisfies WorkjetMailboxStoreShape;
});

export const WorkjetMailboxStoreLive = Layer.effect(WorkjetMailboxStore, make);
