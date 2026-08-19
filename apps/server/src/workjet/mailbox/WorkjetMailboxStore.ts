import {
  WorkjetDelegation,
  WorkjetDelegationId,
  WorkjetDelegationState,
  WorkjetEnvelopeId,
  WorkjetMailboxError,
  WorkjetMailboxPayload,
  WorkjetMailboxTimestamp,
  WorkjetRoutingEnvelope,
  WORKJET_TERMINAL_DELEGATION_STATES,
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

const decodeOutboxDbRow = Schema.decodeUnknownEffect(OutboxDbRow);
const decodeInboxDbRow = Schema.decodeUnknownEffect(InboxDbRow);
const decodeDelegationDbRow = Schema.decodeUnknownEffect(DelegationDbRow);

const encodeRoutingEnvelopeJson = Schema.encodeEffect(
  Schema.fromJsonString(WorkjetRoutingEnvelope),
);
const encodeMailboxPayloadJson = Schema.encodeEffect(Schema.fromJsonString(WorkjetMailboxPayload));
const encodeDelegationJson = Schema.encodeEffect(Schema.fromJsonString(WorkjetDelegation));

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

  readonly listDelegationsByState: (
    state: WorkjetDelegationState,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WorkjetDelegationRecord>, WorkjetMailboxStoreError>;

  readonly expireOverdue: (
    now: WorkjetMailboxTimestamp,
  ) => Effect.Effect<WorkjetMailboxExpirySweep, WorkjetMailboxStoreError>;
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

  const rowIdOf = (row: unknown): string => {
    if (typeof row !== "object" || row === null) {
      return "<unknown>";
    }
    const candidate = row as { readonly envelopeId?: unknown; readonly delegationId?: unknown };
    if (typeof candidate.envelopeId === "string") {
      return candidate.envelopeId;
    }
    return typeof candidate.delegationId === "string" ? candidate.delegationId : "<unknown>";
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
                  expires_at_ms
                )
                VALUES (
                  ${delegation.delegationId},
                  ${delegationJson},
                  ${delegation.state},
                  ${stateChangedAtMillis},
                  ${terminal},
                  ${expiresAtMillis}
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

  return {
    enqueueOutbound,
    recordInboundEnvelope,
    markInboundProcessed,
    listUnprocessedInbound,
    getInbound,
    listPendingOutbound,
    listOutboundByState,
    getOutbound,
    markDelivered,
    recordAttempt,
    upsertDelegation,
    transitionDelegationState,
    getDelegation,
    listDelegationsByState,
    expireOverdue,
  } satisfies WorkjetMailboxStoreShape;
});

export const WorkjetMailboxStoreLive = Layer.effect(WorkjetMailboxStore, make);
