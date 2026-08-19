import {
  EnvironmentId,
  ThreadId,
  WorkjetContentDigest,
  WorkjetDelegationId,
  WorkjetEnvelopeId,
  WorkjetMeshWorkspaceId,
  WorkjetRepositoryPath,
  WorkjetSealedPayloadRef,
  type WorkjetDelegation,
  type WorkjetDelegationState,
  type WorkjetMailboxPayload,
  type WorkjetRoutingEnvelope,
  type WorkjetWorkerAddress,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  WorkjetMailboxStore,
  WorkjetMailboxStoreLive,
  WORKJET_MAILBOX_MAX_DELIVERY_ATTEMPTS,
  isLegalDelegationTransition,
  isWorkjetMailboxError,
  isWorkjetMailboxStoreCorruptRowError,
  workjetMailboxBackoffMillis,
} from "./WorkjetMailboxStore.ts";

const WORKSPACE = WorkjetMeshWorkspaceId.make("workjet-mesh-room-1");
const SOURCE_ENVIRONMENT = EnvironmentId.make("environment-source");
const TARGET_ENVIRONMENT = EnvironmentId.make("environment-target");

const address = (environmentId: EnvironmentId, threadId: string): WorkjetWorkerAddress => ({
  schemaVersion: 1,
  workspaceId: WORKSPACE,
  environmentId,
  threadId: ThreadId.make(threadId),
});

const SOURCE_ADDRESS = address(SOURCE_ENVIRONMENT, "thread-source");
const TARGET_ADDRESS = address(TARGET_ENVIRONMENT, "thread-target");

const envelopeId = (suffix: string): WorkjetEnvelopeId =>
  WorkjetEnvelopeId.make(`envelope-0000000000-${suffix}`);

const delegationId = (suffix: string): WorkjetDelegationId =>
  WorkjetDelegationId.make(`delegation-000000-${suffix}`);

const routingEnvelope = (options: {
  readonly id: WorkjetEnvelopeId;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly kind?: WorkjetRoutingEnvelope["kind"];
}): WorkjetRoutingEnvelope => ({
  schemaVersion: 1,
  envelopeId: options.id,
  kind: options.kind ?? "message",
  sourceWorkspaceId: WORKSPACE,
  sourceEnvironmentId: SOURCE_ENVIRONMENT,
  targetWorkspaceId: WORKSPACE,
  targetEnvironmentId: TARGET_ENVIRONMENT,
  createdAt: options.createdAt,
  expiresAt: options.expiresAt,
  signature: "c2lnbmF0dXJlLWZvci10ZXN0cw",
});

const messagePayload = (id: WorkjetEnvelopeId, createdAt: string, expiresAt: string) =>
  ({
    _tag: "message",
    message: {
      schemaVersion: 1,
      envelopeId: id,
      source: SOURCE_ADDRESS,
      target: TARGET_ADDRESS,
      createdAt,
      expiresAt,
      body: { _tag: "inline", text: "Please review the mailbox slice." },
    },
  }) satisfies WorkjetMailboxPayload;

const delegation = (options: {
  readonly id: WorkjetDelegationId;
  readonly envelope: WorkjetEnvelopeId;
  readonly state: WorkjetDelegationState;
  readonly at: string;
  readonly budgetExpiresAt: string;
}): WorkjetDelegation => ({
  schemaVersion: 1,
  envelopeId: options.envelope,
  delegationId: options.id,
  source: SOURCE_ADDRESS,
  target: TARGET_ADDRESS,
  createdAt: options.at,
  expiresAt: options.budgetExpiresAt,
  prompt: {
    schemaVersion: 1,
    snapshotRef: WorkjetSealedPayloadRef.make("c25hcHNob3QtcmVmZXJlbmNlLTAwMQ"),
    digest: WorkjetContentDigest.make("a".repeat(63) + "b"),
    byteLength: 4_096,
  },
  scope: {
    schemaVersion: 1,
    files: [WorkjetRepositoryPath.make("apps/server/src/workjet/mailbox/WorkjetMailboxStore.ts")],
    nonGoals: "No transport, no relay, no UI.",
  },
  completion: {
    schemaVersion: 1,
    acceptance: "Store tests pass and the server typecheck is clean.",
  },
  budget: {
    schemaVersion: 1,
    maxDepth: 4,
    maxReviewRounds: 2,
    expiresAt: options.budgetExpiresAt,
  },
  state: options.state,
  stateChangedAt: options.at,
  depth: 0,
});

const T0 = "2026-08-19T00:00:00.000Z";
const T1 = "2026-08-19T01:00:00.000Z";
const T2 = "2026-08-19T02:00:00.000Z";
const FAR_FUTURE = "2026-08-20T00:00:00.000Z";
const PAST = "2026-08-18T00:00:00.000Z";

const millis = (iso: string) => Date.parse(iso);

/** Schema-aware narrowing keeps the assertions off unsafe type assertions. */
const assertMailboxErrorReason = (failure: unknown, reason: string) => {
  assert.isTrue(isWorkjetMailboxError(failure));
  if (isWorkjetMailboxError(failure)) {
    assert.equal(failure.reason, reason);
  }
};

const assertCorruptRow = (failure: unknown, table: string, rowId?: string) => {
  assert.isTrue(isWorkjetMailboxStoreCorruptRowError(failure));
  if (isWorkjetMailboxStoreCorruptRowError(failure)) {
    assert.equal(failure.table, table);
    if (rowId !== undefined) {
      assert.equal(failure.rowId, rowId);
    }
  }
};

/**
 * Every test builds its own in-memory database, so the expiry sweep and the
 * listing assertions can make exact, order-independent statements.
 */
const testLayer = Layer.mergeAll(
  WorkjetMailboxStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);
// ===============================
// Outbox
// ===============================

it.effect("enqueues an outbound envelope and reports a duplicate id without throwing", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = envelopeId("out-dup");
    const envelope = routingEnvelope({ id, createdAt: T0, expiresAt: FAR_FUTURE });
    const payload = messagePayload(id, T0, FAR_FUTURE);

    const first = yield* store.enqueueOutbound(envelope, payload);
    assert.equal(first._tag, "enqueued");

    const second = yield* store.enqueueOutbound(envelope, payload);
    assert.equal(second._tag, "duplicate");

    const stored = yield* store.getOutbound(id);
    assert.isTrue(Option.isSome(stored));
    const record = Option.getOrThrow(stored);
    assert.equal(record.state, "pending");
    assert.equal(record.attemptCount, 0);
    assert.equal(record.createdAtMillis, millis(T0));
    assert.equal(record.expiresAtMillis, millis(FAR_FUTURE));
    assert.deepEqual(record.payload, payload);
    assert.deepEqual(record.envelope, envelope);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lists pending outbound work honouring nextAttemptAt, expiry, and the limit", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;

    const dueId = envelopeId("out-due0");
    const expiredId = envelopeId("out-exp0");
    yield* store.enqueueOutbound(
      routingEnvelope({ id: dueId, createdAt: T0, expiresAt: FAR_FUTURE }),
      messagePayload(dueId, T0, FAR_FUTURE),
    );
    yield* store.enqueueOutbound(
      routingEnvelope({ id: expiredId, createdAt: PAST, expiresAt: T0 }),
      messagePayload(expiredId, PAST, T0),
    );

    const due = yield* store.listPendingOutbound(T1, 10);
    assert.deepEqual(
      due.map((record) => record.envelopeId),
      [dueId],
    );

    // A scheduled retry is not due yet.
    const attempt = yield* store.recordAttempt(dueId, T1);
    assert.equal(attempt._tag, "retry-scheduled");
    const stillDue = yield* store.listPendingOutbound(T1, 10);
    assert.deepEqual(stillDue, []);

    // Due again after the backoff, but the expired sibling stays out and the
    // limit is honoured.
    const afterBackoff = yield* store.listPendingOutbound(T2, 10);
    assert.deepEqual(
      afterBackoff.map((record) => record.envelopeId),
      [dueId],
    );
    const limited = yield* store.listPendingOutbound(T2, 1);
    assert.equal(limited.length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("marks an outbound envelope delivered exactly once", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = envelopeId("out-deliv");
    yield* store.enqueueOutbound(
      routingEnvelope({ id, createdAt: T0, expiresAt: FAR_FUTURE }),
      messagePayload(id, T0, FAR_FUTURE),
    );

    const first = yield* store.markDelivered(id, T1);
    assert.equal(first._tag, "delivered");

    const second = yield* store.markDelivered(id, T1);
    assert.equal(second._tag, "not-pending");

    const record = Option.getOrThrow(yield* store.getOutbound(id));
    assert.equal(record.state, "delivered");
    assert.equal(record.deliveredAtMillis, millis(T1));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("backs off exponentially and dead-letters after the attempt budget", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = envelopeId("out-dead0");
    yield* store.enqueueOutbound(
      routingEnvelope({ id, createdAt: T0, expiresAt: FAR_FUTURE }),
      messagePayload(id, T0, FAR_FUTURE),
    );

    const observed: Array<number> = [];
    for (let attempt = 1; attempt < WORKJET_MAILBOX_MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      const outcome = yield* store.recordAttempt(id, T1);
      assert.equal(outcome._tag, "retry-scheduled");
      if (outcome._tag !== "retry-scheduled") {
        return;
      }
      assert.equal(outcome.attemptCount, attempt);
      observed.push(outcome.nextAttemptAtMillis - millis(T1));
    }

    assert.deepEqual(observed, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000]);

    const dead = yield* store.recordAttempt(id, T1);
    assert.equal(dead._tag, "dead-lettered");

    const record = Option.getOrThrow(yield* store.getOutbound(id));
    assert.equal(record.state, "dead");
    assert.equal(record.attemptCount, WORKJET_MAILBOX_MAX_DELIVERY_ATTEMPTS);
    assert.equal(record.deadLetteredAtMillis, millis(T1));

    const deadLetters = yield* store.listOutboundByState("dead", 10);
    assert.deepEqual(
      deadLetters.map((entry) => entry.envelopeId),
      [id],
    );

    // A dead letter is no longer schedulable, and a further attempt is a no-op.
    const pending = yield* store.listPendingOutbound(T2, 10);
    assert.isFalse(pending.some((entry) => entry.envelopeId === id));
    const afterDeath = yield* store.recordAttempt(id, T1);
    assert.equal(afterDeath._tag, "not-pending");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("caps the exponential backoff", () => {
  assert.equal(workjetMailboxBackoffMillis(1), 1_000);
  assert.equal(workjetMailboxBackoffMillis(9), 256_000);
  assert.equal(workjetMailboxBackoffMillis(40), 300_000);
  return Effect.void;
});

// ===============================
// Inbox idempotency
// ===============================

it.effect("inserts an inbound envelope idempotently and rejects an expired one", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;

    const id = envelopeId("in-dedup");
    const envelope = routingEnvelope({ id, createdAt: T0, expiresAt: FAR_FUTURE });
    const payload = messagePayload(id, T0, FAR_FUTURE);

    const first = yield* store.recordInboundEnvelope(envelope, payload, T0);
    assert.equal(first._tag, "accepted-new");

    const replay = yield* store.recordInboundEnvelope(envelope, payload, T1);
    assert.equal(replay._tag, "duplicate-ignored");

    const stored = Option.getOrThrow(yield* store.getInbound(id));
    assert.equal(stored.receivedAtMillis, millis(T0));
    assert.isNull(stored.processedAtMillis);
    assert.deepEqual(stored.payload, payload);

    const expiredEnvelopeId = envelopeId("in-expird");
    const expiredEnvelope = routingEnvelope({
      id: expiredEnvelopeId,
      createdAt: PAST,
      expiresAt: T0,
    });
    const expired = yield* store.recordInboundEnvelope(
      expiredEnvelope,
      messagePayload(expiredEnvelopeId, PAST, T0),
      T1,
    );
    assert.equal(expired._tag, "expired");
    assert.isTrue(Option.isNone(yield* store.getInbound(expiredEnvelopeId)));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("marks an inbound envelope processed once", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = envelopeId("in-procss");
    yield* store.recordInboundEnvelope(
      routingEnvelope({ id, createdAt: T0, expiresAt: FAR_FUTURE }),
      messagePayload(id, T0, FAR_FUTURE),
      T0,
    );

    const unprocessed = yield* store.listUnprocessedInbound(10);
    assert.deepEqual(
      unprocessed.map((entry) => entry.envelopeId),
      [id],
    );

    assert.isTrue(yield* store.markInboundProcessed(id, T1));
    assert.isFalse(yield* store.markInboundProcessed(id, T1));
    assert.deepEqual(yield* store.listUnprocessedInbound(10), []);
  }).pipe(Effect.provide(testLayer)),
);

// ===============================
// Delegation state machine
// ===============================

it.effect("upserts a delegation and refuses a state change through the upsert path", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("upsert01");
    const record = delegation({
      id,
      envelope: envelopeId("del-upsert"),
      state: "queued",
      at: T0,
      budgetExpiresAt: FAR_FUTURE,
    });

    const inserted = yield* store.upsertDelegation(record);
    assert.equal(inserted._tag, "inserted");

    const updated = yield* store.upsertDelegation({ ...record, depth: 1 });
    assert.equal(updated._tag, "updated");

    const stored = Option.getOrThrow(yield* store.getDelegation(id));
    assert.equal(stored.state, "queued");
    assert.equal(stored.delegation.depth, 1);
    assert.isFalse(stored.terminal);

    const smuggled = yield* store
      .upsertDelegation({ ...record, state: "running" })
      .pipe(Effect.result);
    assert.equal(smuggled._tag, "Failure");
    if (smuggled._tag === "Failure") {
      assertMailboxErrorReason(smuggled.failure, "invalid-state-transition");
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("walks the full legal delegation lifecycle", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("lifecyc1");
    yield* store.upsertDelegation(
      delegation({
        id,
        envelope: envelopeId("del-lifecyc"),
        state: "queued",
        at: T0,
        budgetExpiresAt: FAR_FUTURE,
      }),
    );

    const chain: ReadonlyArray<readonly [WorkjetDelegationState, WorkjetDelegationState]> = [
      ["queued", "delivered"],
      ["delivered", "accepted"],
      ["accepted", "running"],
      ["running", "needs-input"],
      ["needs-input", "running"],
      ["running", "review-requested"],
      ["review-requested", "changes-requested"],
      ["changes-requested", "running"],
      ["running", "review-requested"],
      ["review-requested", "completed"],
    ];

    for (const [from, to] of chain) {
      const moved = yield* store.transitionDelegationState(id, from, to, T1);
      assert.equal(moved.state, to);
      assert.equal(moved.delegation.state, to);
      assert.equal(moved.delegation.stateChangedAt, T1);
    }

    const final = Option.getOrThrow(yield* store.getDelegation(id));
    assert.equal(final.state, "completed");
    assert.isTrue(final.terminal);
    assert.equal(final.delegation.state, "completed");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects an illegal transition and keeps a terminal delegation immutable", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("illegal1");
    yield* store.upsertDelegation(
      delegation({
        id,
        envelope: envelopeId("del-illegal"),
        state: "queued",
        at: T0,
        budgetExpiresAt: FAR_FUTURE,
      }),
    );

    // Skipping the delivered/accepted steps is not representable.
    const skipped = yield* store
      .transitionDelegationState(id, "queued", "running", T1)
      .pipe(Effect.result);
    assert.equal(skipped._tag, "Failure");
    if (skipped._tag === "Failure") {
      assertMailboxErrorReason(skipped.failure, "invalid-state-transition");
    }

    // A stale `from` fails even when the target transition would be legal.
    const stale = yield* store
      .transitionDelegationState(id, "running", "review-requested", T1)
      .pipe(Effect.result);
    assert.equal(stale._tag, "Failure");

    const unchanged = Option.getOrThrow(yield* store.getDelegation(id));
    assert.equal(unchanged.state, "queued");
    assert.equal(unchanged.delegation.stateChangedAt, T0);

    // Any non-terminal state may still be cancelled.
    const cancelled = yield* store.transitionDelegationState(id, "queued", "cancelled", T1);
    assert.equal(cancelled.state, "cancelled");
    assert.isTrue(cancelled.terminal);

    for (const target of [
      "running",
      "completed",
      "failed",
      "expired",
      "cancelled",
    ] as ReadonlyArray<WorkjetDelegationState>) {
      const blocked = yield* store
        .transitionDelegationState(id, "cancelled", target, T1)
        .pipe(Effect.result);
      assert.equal(blocked._tag, "Failure");
      if (blocked._tag === "Failure") {
        assertMailboxErrorReason(blocked.failure, "invalid-state-transition");
      }
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("fails an unknown delegation transition with a typed unknown-target", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const missing = yield* store
      .transitionDelegationState(delegationId("nowhere1"), "queued", "delivered", T1)
      .pipe(Effect.result);
    assert.equal(missing._tag, "Failure");
    if (missing._tag === "Failure") {
      assertMailboxErrorReason(missing.failure, "unknown-target");
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("encodes the transition table exactly as documented", () => {
  assert.isTrue(isLegalDelegationTransition("queued", "delivered"));
  assert.isTrue(isLegalDelegationTransition("delivered", "accepted"));
  assert.isTrue(isLegalDelegationTransition("accepted", "running"));
  assert.isTrue(isLegalDelegationTransition("running", "needs-input"));
  assert.isTrue(isLegalDelegationTransition("needs-input", "running"));
  assert.isTrue(isLegalDelegationTransition("running", "review-requested"));
  assert.isTrue(isLegalDelegationTransition("review-requested", "changes-requested"));
  assert.isTrue(isLegalDelegationTransition("changes-requested", "running"));
  assert.isTrue(isLegalDelegationTransition("review-requested", "completed"));

  for (const from of [
    "queued",
    "delivered",
    "accepted",
    "running",
    "needs-input",
    "review-requested",
    "changes-requested",
  ] as ReadonlyArray<WorkjetDelegationState>) {
    assert.isTrue(isLegalDelegationTransition(from, "cancelled"));
    assert.isTrue(isLegalDelegationTransition(from, "expired"));
    assert.isTrue(isLegalDelegationTransition(from, "failed"));
  }

  for (const from of [
    "completed",
    "failed",
    "cancelled",
    "expired",
  ] as ReadonlyArray<WorkjetDelegationState>) {
    for (const to of [
      "queued",
      "delivered",
      "accepted",
      "running",
      "needs-input",
      "review-requested",
      "changes-requested",
      "completed",
      "failed",
      "cancelled",
      "expired",
    ] as ReadonlyArray<WorkjetDelegationState>) {
      assert.isFalse(isLegalDelegationTransition(from, to));
    }
  }

  assert.isFalse(isLegalDelegationTransition("queued", "running"));
  assert.isFalse(isLegalDelegationTransition("running", "completed"));
  return Effect.void;
});

// ===============================
// Expiry sweep
// ===============================

it.effect("sweeps overdue outbox, inbox, and non-terminal delegation rows in one pass", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;

    const overdueOut = envelopeId("sw-outold");
    const liveOut = envelopeId("sw-outnew");
    yield* store.enqueueOutbound(
      routingEnvelope({ id: overdueOut, createdAt: PAST, expiresAt: T0 }),
      messagePayload(overdueOut, PAST, T0),
    );
    yield* store.enqueueOutbound(
      routingEnvelope({ id: liveOut, createdAt: T0, expiresAt: FAR_FUTURE }),
      messagePayload(liveOut, T0, FAR_FUTURE),
    );

    const overdueIn = envelopeId("sw-in-old");
    const liveIn = envelopeId("sw-in-new");
    yield* store.recordInboundEnvelope(
      routingEnvelope({ id: overdueIn, createdAt: PAST, expiresAt: T1 }),
      messagePayload(overdueIn, PAST, T1),
      T0,
    );
    yield* store.recordInboundEnvelope(
      routingEnvelope({ id: liveIn, createdAt: T0, expiresAt: FAR_FUTURE }),
      messagePayload(liveIn, T0, FAR_FUTURE),
      T0,
    );

    const overdueDelegation = delegationId("sw-delold");
    const liveDelegation = delegationId("sw-delnew");
    const terminalDelegation = delegationId("sw-delend");
    yield* store.upsertDelegation(
      delegation({
        id: overdueDelegation,
        envelope: envelopeId("del-sw-old"),
        state: "running",
        at: T0,
        budgetExpiresAt: T1,
      }),
    );
    yield* store.upsertDelegation(
      delegation({
        id: liveDelegation,
        envelope: envelopeId("del-sw-new"),
        state: "running",
        at: T0,
        budgetExpiresAt: FAR_FUTURE,
      }),
    );
    yield* store.upsertDelegation(
      delegation({
        id: terminalDelegation,
        envelope: envelopeId("del-sw-end"),
        state: "completed",
        at: T0,
        budgetExpiresAt: T1,
      }),
    );

    const sweep = yield* store.expireOverdue(T1);
    assert.deepEqual(sweep, {
      outboxDeadLettered: 1,
      inboxDropped: 1,
      delegationsExpired: 1,
    });

    const sweptOut = Option.getOrThrow(yield* store.getOutbound(overdueOut));
    assert.equal(sweptOut.state, "dead");
    assert.equal(sweptOut.deadLetteredAtMillis, millis(T1));
    assert.equal(Option.getOrThrow(yield* store.getOutbound(liveOut)).state, "pending");

    assert.isTrue(Option.isNone(yield* store.getInbound(overdueIn)));
    assert.isTrue(Option.isSome(yield* store.getInbound(liveIn)));

    const sweptDelegation = Option.getOrThrow(yield* store.getDelegation(overdueDelegation));
    assert.equal(sweptDelegation.state, "expired");
    assert.isTrue(sweptDelegation.terminal);
    assert.equal(sweptDelegation.delegation.state, "expired");
    assert.equal(sweptDelegation.delegation.stateChangedAt, T1);

    assert.equal(Option.getOrThrow(yield* store.getDelegation(liveDelegation)).state, "running");
    const untouched = Option.getOrThrow(yield* store.getDelegation(terminalDelegation));
    assert.equal(untouched.state, "completed");
    assert.equal(untouched.delegation.stateChangedAt, T0);

    const secondSweep = yield* store.expireOverdue(T1);
    assert.deepEqual(secondSweep, {
      outboxDeadLettered: 0,
      inboxDropped: 0,
      delegationsExpired: 0,
    });
  }).pipe(Effect.provide(testLayer)),
);

// ===============================
// Corrupt rows
// ===============================

it.effect("surfaces an undecodable outbox row as a typed corrupt-row error", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const sql = yield* SqlClient.SqlClient;
    const id = envelopeId("corrupt-o");

    yield* store.enqueueOutbound(
      routingEnvelope({ id, createdAt: T0, expiresAt: FAR_FUTURE }),
      messagePayload(id, T0, FAR_FUTURE),
    );

    yield* sql`
      UPDATE workjet_mailbox_outbox
      SET payload_json = 'not-json-at-all'
      WHERE envelope_id = ${id}
    `;

    const corrupt = yield* store.getOutbound(id).pipe(Effect.result);
    assert.equal(corrupt._tag, "Failure");
    if (corrupt._tag === "Failure") {
      assertCorruptRow(corrupt.failure, "workjet_mailbox_outbox", id);
    }

    const listed = yield* store.listOutboundByState("pending", 10).pipe(Effect.result);
    assert.equal(listed._tag, "Failure");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("surfaces an undecodable delegation row as a typed corrupt-row error", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const sql = yield* SqlClient.SqlClient;
    const id = delegationId("corrupt1");

    yield* store.upsertDelegation(
      delegation({
        id,
        envelope: envelopeId("del-corrupt"),
        state: "queued",
        at: T0,
        budgetExpiresAt: FAR_FUTURE,
      }),
    );

    yield* sql`
      UPDATE workjet_delegations
      SET delegation_json = '{"schemaVersion":1}'
      WHERE delegation_id = ${id}
    `;

    const read = yield* store.getDelegation(id).pipe(Effect.result);
    assert.equal(read._tag, "Failure");
    if (read._tag === "Failure") {
      assertCorruptRow(read.failure, "workjet_delegations", id);
    }

    // The transition path decodes through the same schema, so it fails typed
    // instead of writing a state change over an unreadable row.
    const transitioned = yield* store
      .transitionDelegationState(id, "queued", "delivered", T1)
      .pipe(Effect.result);
    assert.equal(transitioned._tag, "Failure");
    if (transitioned._tag === "Failure") {
      assertCorruptRow(transitioned.failure, "workjet_delegations", id);
    }

    const rows = yield* sql<{ readonly state: string }>`
      SELECT state AS "state" FROM workjet_delegations WHERE delegation_id = ${id}
    `;
    assert.equal(rows[0]?.state, "queued");
  }).pipe(Effect.provide(testLayer)),
);
