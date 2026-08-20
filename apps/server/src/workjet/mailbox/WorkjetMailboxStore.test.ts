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
  type WorkjetDelegationResult,
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
  workjetDelegationEdgeId,
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

const delegationResult = (options: {
  readonly id: WorkjetDelegationId;
  readonly envelope: WorkjetEnvelopeId;
  readonly outcome: "completed" | "failed";
}): WorkjetDelegationResult => ({
  schemaVersion: 1,
  envelopeId: options.envelope,
  delegation: { schemaVersion: 1, delegationId: options.id, owner: TARGET_ADDRESS },
  reportedBy: TARGET_ADDRESS,
  reportedAt: T1,
  outcome: options.outcome,
  summary: "Delegation turn completed.",
  artifacts: { schemaVersion: 1, commitHashes: [], paths: [] },
});

it.effect("finalizes a running delegation with its result and is idempotent", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("finalize");
    yield* store.upsertDelegation(
      delegation({
        id,
        envelope: envelopeId("finalize0"),
        state: "queued",
        at: T0,
        budgetExpiresAt: FAR_FUTURE,
      }),
    );
    yield* store.transitionDelegationState(id, "queued", "delivered", T0);
    yield* store.transitionDelegationState(id, "delivered", "accepted", T0);
    yield* store.transitionDelegationState(id, "accepted", "running", T0);

    const stored = delegationResult({
      id,
      envelope: envelopeId("result00"),
      outcome: "completed",
    });
    const first = yield* store.finalizeDelegationResult({
      delegationId: id,
      to: "completed",
      result: stored,
      changedAt: T1,
    });
    assert.equal(first._tag, "finalized");
    assert.equal(first.record.state, "completed");
    assert.isTrue(first.record.terminal);

    const record = yield* store.getDelegation(id);
    if (Option.isNone(record)) return assert.fail("delegation missing");
    assert.equal(record.value.state, "completed");
    assert.isTrue(record.value.terminal);

    const persisted = yield* store.getDelegationResult(id);
    if (Option.isNone(persisted)) return assert.fail("result missing");
    assert.deepEqual(persisted.value, stored);

    // A duplicate finalize — even with a DIFFERENT payload and outcome — returns
    // the ALREADY-stored result and never transitions or overwrites again.
    const other = delegationResult({ id, envelope: envelopeId("result99"), outcome: "failed" });
    const second = yield* store.finalizeDelegationResult({
      delegationId: id,
      to: "failed",
      result: other,
      changedAt: T2,
    });
    assert.equal(second._tag, "already-finalized");
    assert.deepEqual(second.result, stored);

    const still = yield* store.getDelegationResult(id);
    if (Option.isNone(still)) return assert.fail("result missing after replay");
    assert.deepEqual(still.value, stored);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("queues an unreturned delegation result and stamps it exactly once", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const finalize = Effect.fn("test.finalize")(function* (suffix: string) {
      const id = delegationId(suffix);
      yield* store.upsertDelegation(
        delegation({
          id,
          envelope: envelopeId(`${suffix}0`.slice(0, 8)),
          state: "queued",
          at: T0,
          budgetExpiresAt: FAR_FUTURE,
        }),
      );
      yield* store.transitionDelegationState(id, "queued", "delivered", T0);
      yield* store.transitionDelegationState(id, "delivered", "accepted", T0);
      yield* store.transitionDelegationState(id, "accepted", "running", T0);
      yield* store.finalizeDelegationResult({
        delegationId: id,
        to: "completed",
        result: delegationResult({ id, envelope: envelopeId("res-ret0"), outcome: "completed" }),
        changedAt: T1,
      });
      return id;
    });

    // A delegation that never finalized carries no result, so it is not a
    // pending RETURN — only finalized rows with a stored result qualify.
    const unfinished = delegationId("ret-open");
    yield* store.upsertDelegation(
      delegation({
        id: unfinished,
        envelope: envelopeId("ret-open"),
        state: "queued",
        at: T0,
        budgetExpiresAt: FAR_FUTURE,
      }),
    );
    const returned = yield* finalize("ret-done");
    const abandoned = yield* finalize("ret-lost");

    const pending = yield* store.listDelegationsPendingResultReturn(10);
    assert.deepEqual(
      pending.map((row) => (row._tag === "record" ? row.record.delegationId : row.delegationId)),
      [returned, abandoned],
    );

    // Both markers remove a row from the queue, and each stamps exactly once.
    assert.isTrue(yield* store.markDelegationResultReturned(returned, T2));
    assert.isFalse(yield* store.markDelegationResultReturned(returned, T2));
    assert.isTrue(yield* store.markDelegationResultReturnFailed(abandoned, T2));
    assert.isFalse(yield* store.markDelegationResultReturnFailed(abandoned, T2));

    assert.deepEqual([...(yield* store.listDelegationsPendingResultReturn(10))], []);
    // The durable result itself is untouched by either marker.
    assert.isTrue(Option.isSome(yield* store.getDelegationResult(abandoned)));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("drops a reconciled outbox row from the unreconciled scan only", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = envelopeId("recon001");
    yield* store.enqueueOutbound(
      routingEnvelope({ id, createdAt: T0, expiresAt: FAR_FUTURE }),
      messagePayload(id, T0, FAR_FUTURE),
    );

    // A pending row is visible to both scans until it is marked.
    assert.equal((yield* store.listUnreconciledOutboundByState("pending", 10)).length, 1);
    assert.isTrue(yield* store.markOutboundReconciled(id, T1));
    assert.isFalse(yield* store.markOutboundReconciled(id, T2));

    assert.equal((yield* store.listUnreconciledOutboundByState("pending", 10)).length, 0);
    // The row itself is untouched: only the reconciler's scan set shrinks.
    assert.equal((yield* store.listOutboundByState("pending", 10)).length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses to finalize a delegation that is not running", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("notrun0");
    yield* store.upsertDelegation(
      delegation({
        id,
        envelope: envelopeId("notrun00"),
        state: "queued",
        at: T0,
        budgetExpiresAt: FAR_FUTURE,
      }),
    );
    const refused = yield* store
      .finalizeDelegationResult({
        delegationId: id,
        to: "completed",
        result: delegationResult({ id, envelope: envelopeId("result11"), outcome: "completed" }),
        changedAt: T1,
      })
      .pipe(Effect.result);
    assert.equal(refused._tag, "Failure");
    if (refused._tag === "Failure") {
      assertMailboxErrorReason(refused.failure, "invalid-state-transition");
    }
    assert.isTrue(Option.isNone(yield* store.getDelegationResult(id)));
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
  // A zero-review-round budget must be able to finish without a review gate.
  assert.isTrue(isLegalDelegationTransition("running", "completed"));

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
  assert.isFalse(isLegalDelegationTransition("needs-input", "completed"));
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

// ===============================
// Version skew: resilient by-state row scan
// ===============================

it.effect(
  "lists a version-skewed delegation row as a corrupt marker, never failing the batch",
  () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const sql = yield* SqlClient.SqlClient;

      // Two delivered delegations. The FIRST scans cleanly; the SECOND is rewritten
      // to a shape the current schema cannot decode (the concrete face of target
      // version skew). state_changed_at_ms orders them, so the readable row is not
      // merely lucky to come first.
      const good = delegationId("skew-ok");
      const skewed = delegationId("skew-bad");
      yield* store.upsertDelegation(
        delegation({
          id: good,
          envelope: envelopeId("skew-ok"),
          state: "delivered",
          at: T0,
          budgetExpiresAt: FAR_FUTURE,
        }),
      );
      yield* store.upsertDelegation(
        delegation({
          id: skewed,
          envelope: envelopeId("skew-bad"),
          state: "delivered",
          at: T1,
          budgetExpiresAt: FAR_FUTURE,
        }),
      );
      yield* sql`
      UPDATE workjet_delegations
      SET delegation_json = '{"schemaVersion":999}'
      WHERE delegation_id = ${skewed}
    `;

      // The whole effect succeeds: one decoded record, one bounded corrupt marker.
      const rows = yield* store.listDelegationRowsByState("delivered", 32);
      assert.equal(rows.length, 2);
      const records = rows.filter((row) => row._tag === "record");
      const corrupt = rows.filter((row) => row._tag === "corrupt");
      assert.equal(records.length, 1);
      assert.equal(corrupt.length, 1);
      if (records[0]?._tag === "record") {
        assert.equal(records[0].record.delegationId, good);
      }
      // The corrupt marker names the row by its stable id and carries no payload.
      if (corrupt[0]?._tag === "corrupt") {
        assert.equal(corrupt[0].rowId, skewed);
      }
    }).pipe(Effect.provide(testLayer)),
);

// ===============================
// Reassignment
// ===============================

it.effect("reassigns a delivered delegation to a different local target thread in place", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("reassign-ok");
    yield* store.upsertDelegation(
      delegation({
        id,
        envelope: envelopeId("reassign-ok"),
        state: "delivered",
        at: T0,
        budgetExpiresAt: FAR_FUTURE,
      }),
    );

    const newTarget = address(TARGET_ENVIRONMENT, "thread-target-2");
    const record = yield* store.reassignDelegation(id, newTarget, T1);

    // The target moved; the lifecycle state did NOT.
    assert.equal(record.state, "delivered");
    assert.equal(record.terminal, false);
    assert.equal(record.delegation.target.threadId, newTarget.threadId);

    // The change is durable and the delegation body agrees with the column.
    const stored = yield* store.getDelegation(id);
    assert.isTrue(Option.isSome(stored));
    if (Option.isSome(stored)) {
      assert.equal(stored.value.state, "delivered");
      assert.equal(stored.value.delegation.target.threadId, newTarget.threadId);
      assert.equal(stored.value.delegation.stateChangedAt, T1);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses to reassign a running or terminal delegation", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const newTarget = address(TARGET_ENVIRONMENT, "thread-target-2");

    // A running delegation: work already began; it must never be moved.
    const running = delegationId("reassign-run");
    yield* store.upsertDelegation(
      delegation({
        id: running,
        envelope: envelopeId("reassign-run"),
        state: "delivered",
        at: T0,
        budgetExpiresAt: FAR_FUTURE,
      }),
    );
    yield* store.transitionDelegationState(running, "delivered", "accepted", T1);
    yield* store.transitionDelegationState(running, "accepted", "running", T1);
    const runFail = yield* store.reassignDelegation(running, newTarget, T2).pipe(Effect.result);
    assert.equal(runFail._tag, "Failure");
    if (runFail._tag === "Failure") {
      assertMailboxErrorReason(runFail.failure, "invalid-state-transition");
    }
    // Unmoved.
    const runStored = yield* store.getDelegation(running);
    if (Option.isSome(runStored)) {
      assert.equal(runStored.value.delegation.target.threadId, TARGET_ADDRESS.threadId);
      assert.equal(runStored.value.state, "running");
    }

    // A terminal delegation: cancel it, then the reassignment is refused.
    const cancelled = delegationId("reassign-term");
    yield* store.upsertDelegation(
      delegation({
        id: cancelled,
        envelope: envelopeId("reassign-term"),
        state: "delivered",
        at: T0,
        budgetExpiresAt: FAR_FUTURE,
      }),
    );
    yield* store.transitionDelegationState(cancelled, "delivered", "cancelled", T1);
    const termFail = yield* store.reassignDelegation(cancelled, newTarget, T2).pipe(Effect.result);
    assert.equal(termFail._tag, "Failure");
    if (termFail._tag === "Failure") {
      assertMailboxErrorReason(termFail.failure, "invalid-state-transition");
    }

    // An unknown delegation is an unknown target, not a corrupt-row crash.
    const missing = yield* store
      .reassignDelegation(delegationId("reassign-none"), newTarget, T2)
      .pipe(Effect.result);
    assert.equal(missing._tag, "Failure");
    if (missing._tag === "Failure") {
      assertMailboxErrorReason(missing.failure, "unknown-target");
    }
  }).pipe(Effect.provide(testLayer)),
);

// ===============================
// Delegation graph edges
// ===============================

const ref = (delegationSuffix: string, owner: WorkjetWorkerAddress) => ({
  schemaVersion: 1 as const,
  delegationId: delegationId(delegationSuffix),
  owner,
});

const edge = (options: {
  readonly kind: "reviews" | "revises" | "follows-up";
  readonly from: string;
  readonly to: string;
  readonly at?: string;
  readonly depth?: number;
}) => ({
  schemaVersion: 1 as const,
  kind: options.kind,
  from: ref(options.from, SOURCE_ADDRESS),
  to: ref(options.to, TARGET_ADDRESS),
  createdAt: options.at ?? T0,
  depth: options.depth ?? 0,
});

it.effect("inserts a delegation-graph edge idempotently on its stable id", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const reviewEdge = edge({ kind: "reviews", from: "rev", to: "work" });

    const first = yield* store.insertDelegationEdge(reviewEdge);
    assert.equal(first._tag, "inserted");
    // The id is DERIVED from kind/from/to, so the store and callers agree.
    assert.equal(first.edgeId, workjetDelegationEdgeId(reviewEdge));

    // Re-inserting the identical relationship is a no-op, never a second row.
    const second = yield* store.insertDelegationEdge(reviewEdge);
    assert.equal(second._tag, "duplicate");
    assert.equal(second.edgeId, first.edgeId);

    const edges = yield* store.listDelegationEdges(delegationId("work"), 32);
    assert.equal(edges.length, 1);
    assert.equal(edges[0]?.kind, "reviews");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lists every edge touching a delegation as from or to, in creation order", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;

    // "work" is the `to` of a review and the `from` of a follow-up: both must
    // be returned by listDelegationEdges(work).
    yield* store.insertDelegationEdge(edge({ kind: "reviews", from: "rev", to: "work", at: T0 }));
    yield* store.insertDelegationEdge(
      edge({ kind: "follows-up", from: "work", to: "next", at: T1, depth: 1 }),
    );
    // An unrelated edge that must NOT appear for "work".
    yield* store.insertDelegationEdge(edge({ kind: "revises", from: "other", to: "elsewhere" }));

    const edges = yield* store.listDelegationEdges(delegationId("work"), 32);
    assert.deepEqual(
      edges.map((value) => value.kind),
      ["reviews", "follows-up"],
    );

    // Distinct kinds/endpoints yield distinct ids, so both rows survive.
    const other = yield* store.listDelegationEdges(delegationId("elsewhere"), 32);
    assert.deepEqual(
      other.map((value) => value.kind),
      ["revises"],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("surfaces a corrupt edge row as a typed failure, never a crash", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.insertDelegationEdge(edge({ kind: "reviews", from: "rev", to: "work" }));

    yield* sql`
      UPDATE workjet_delegation_edges
      SET edge_json = '{"schemaVersion":1}'
    `;

    const read = yield* store.listDelegationEdges(delegationId("work"), 32).pipe(Effect.result);
    assert.equal(read._tag, "Failure");
    if (read._tag === "Failure") {
      assertCorruptRow(read.failure, "workjet_delegation_edges");
    }
  }).pipe(Effect.provide(testLayer)),
);

// ===============================
// Usage accounting and approval gate (migration 048)
// ===============================

/** A delegation with the additive token/cost/approval budget fields applied. */
const budgetedDelegation = (options: {
  readonly id: WorkjetDelegationId;
  readonly envelope: WorkjetEnvelopeId;
  readonly state: WorkjetDelegationState;
  readonly at: string;
  readonly maxTokens?: number;
  readonly maxCostMicros?: number;
  readonly requiresApproval?: boolean;
}): WorkjetDelegation => {
  const base = delegation({
    id: options.id,
    envelope: options.envelope,
    state: options.state,
    at: options.at,
    budgetExpiresAt: FAR_FUTURE,
  });
  return {
    ...base,
    budget: {
      ...base.budget,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.maxCostMicros !== undefined ? { maxCostMicros: options.maxCostMicros } : {}),
      ...(options.requiresApproval !== undefined
        ? { requiresApproval: options.requiresApproval }
        : {}),
    },
  };
};

it.effect("accumulates usage and starts a non-gated delegation at zero, not-required", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("usage001");
    yield* store.upsertDelegation(
      budgetedDelegation({ id, envelope: envelopeId("del-usage1"), state: "queued", at: T0 }),
    );

    const initial = Option.getOrThrow(yield* store.getDelegationAccounting(id));
    assert.deepEqual(initial, { tokens: 0, costMicros: 0, approvalState: "not-required" });

    const first = yield* store.recordDelegationUsage(id, 100, 2_000);
    assert.deepEqual(first, { tokens: 100, costMicros: 2_000 });
    const second = yield* store.recordDelegationUsage(id, 50, 500);
    assert.deepEqual(second, { tokens: 150, costMicros: 2_500 });

    const after = Option.getOrThrow(yield* store.getDelegationAccounting(id));
    assert.deepEqual(after, { tokens: 150, costMicros: 2_500, approvalState: "not-required" });
    // With no gate, the delegation is executable throughout.
    assert.isTrue(yield* store.isDelegationExecutable(id));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a token charge that would cross the ceiling and writes nothing", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("usage002");
    yield* store.upsertDelegation(
      budgetedDelegation({
        id,
        envelope: envelopeId("del-usage2"),
        state: "queued",
        at: T0,
        maxTokens: 1_000,
      }),
    );

    yield* store.recordDelegationUsage(id, 900, 0);
    // 900 + 200 = 1_100 > 1_000: refused BEFORE the durable write.
    const refused = yield* store.recordDelegationUsage(id, 200, 0).pipe(Effect.result);
    assert.equal(refused._tag, "Failure");
    if (refused._tag === "Failure") {
      assertMailboxErrorReason(refused.failure, "token-budget-exceeded");
    }

    // The refused charge left the total exactly where the last success did.
    const after = Option.getOrThrow(yield* store.getDelegationAccounting(id));
    assert.equal(after.tokens, 900);

    // Reaching the ceiling exactly is allowed; exceeding it by one is not.
    const exact = yield* store.recordDelegationUsage(id, 100, 0);
    assert.equal(exact.tokens, 1_000);
    const overByOne = yield* store.recordDelegationUsage(id, 1, 0).pipe(Effect.result);
    assert.equal(overByOne._tag, "Failure");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a cost charge that would cross the ceiling and writes nothing", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("usage003");
    yield* store.upsertDelegation(
      budgetedDelegation({
        id,
        envelope: envelopeId("del-usage3"),
        state: "queued",
        at: T0,
        maxCostMicros: 5_000,
      }),
    );

    yield* store.recordDelegationUsage(id, 0, 4_000);
    const refused = yield* store.recordDelegationUsage(id, 0, 2_000).pipe(Effect.result);
    assert.equal(refused._tag, "Failure");
    if (refused._tag === "Failure") {
      assertMailboxErrorReason(refused.failure, "cost-budget-exceeded");
    }
    const after = Option.getOrThrow(yield* store.getDelegationAccounting(id));
    assert.equal(after.costMicros, 4_000);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a negative usage delta as malformed", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("usage004");
    yield* store.upsertDelegation(
      budgetedDelegation({ id, envelope: envelopeId("del-usage4"), state: "queued", at: T0 }),
    );
    const bad = yield* store.recordDelegationUsage(id, -1, 0).pipe(Effect.result);
    assert.equal(bad._tag, "Failure");
    if (bad._tag === "Failure") {
      assertMailboxErrorReason(bad.failure, "malformed-envelope");
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("fails usage accounting for an unknown delegation", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const missing = yield* store
      .recordDelegationUsage(delegationId("nope0000"), 1, 1)
      .pipe(Effect.result);
    assert.equal(missing._tag, "Failure");
    if (missing._tag === "Failure") {
      assertMailboxErrorReason(missing.failure, "unknown-target");
    }
    assert.isTrue(Option.isNone(yield* store.getDelegationAccounting(delegationId("nope0000"))));
    // A missing delegation is never executable.
    assert.isFalse(yield* store.isDelegationExecutable(delegationId("nope0000")));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("gates a requiresApproval delegation as pending until approved", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("approve1");
    yield* store.upsertDelegation(
      budgetedDelegation({
        id,
        envelope: envelopeId("del-approve1"),
        state: "delivered",
        at: T0,
        requiresApproval: true,
      }),
    );

    const gated = Option.getOrThrow(yield* store.getDelegationAccounting(id));
    assert.equal(gated.approvalState, "pending");
    // Pending approval blocks execution.
    assert.isFalse(yield* store.isDelegationExecutable(id));

    const approved = yield* store.setDelegationApproval(id, true, T1);
    assert.equal(approved.approvalState, "approved");
    assert.isTrue(yield* store.isDelegationExecutable(id));
    // The delegation state itself is untouched by approval.
    const record = Option.getOrThrow(yield* store.getDelegation(id));
    assert.equal(record.state, "delivered");
    assert.isFalse(record.terminal);

    // Re-deciding a settled gate is an illegal transition.
    const again = yield* store.setDelegationApproval(id, true, T2).pipe(Effect.result);
    assert.equal(again._tag, "Failure");
    if (again._tag === "Failure") {
      assertMailboxErrorReason(again.failure, "invalid-state-transition");
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejection cancels the delegation terminally and keeps it non-executable", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("reject01");
    yield* store.upsertDelegation(
      budgetedDelegation({
        id,
        envelope: envelopeId("del-reject1"),
        state: "delivered",
        at: T0,
        requiresApproval: true,
      }),
    );

    const rejected = yield* store.setDelegationApproval(id, false, T1);
    assert.equal(rejected.approvalState, "rejected");
    assert.isFalse(yield* store.isDelegationExecutable(id));

    // Rejection is terminal: the delegation is cancelled in the same transaction.
    const record = Option.getOrThrow(yield* store.getDelegation(id));
    assert.equal(record.state, "cancelled");
    assert.isTrue(record.terminal);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses to approve a delegation that has no pending gate", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const id = delegationId("nogate01");
    yield* store.upsertDelegation(
      budgetedDelegation({ id, envelope: envelopeId("del-nogate1"), state: "delivered", at: T0 }),
    );
    // not-required cannot be approved.
    const nope = yield* store.setDelegationApproval(id, true, T1).pipe(Effect.result);
    assert.equal(nope._tag, "Failure");
    if (nope._tag === "Failure") {
      assertMailboxErrorReason(nope.failure, "invalid-state-transition");
    }
    assert.isTrue(yield* store.isDelegationExecutable(id));
  }).pipe(Effect.provide(testLayer)),
);

// ===============================
// Mesh roster read (peer pins)
// ===============================

const pinPeer = (input: {
  readonly environmentId: string;
  readonly firstSeenAtMillis: number;
  readonly encryptionPublicKey?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO workjet_mailbox_peer_keys
        (source_workspace_id, source_environment_id, public_key, encryption_public_key,
         first_seen_at_ms)
      VALUES (${WORKSPACE}, ${input.environmentId}, ${"signing-key-for-tests"},
              ${input.encryptionPublicKey ?? null}, ${input.firstSeenAtMillis})
    `;
  });

it.effect("lists pinned peers oldest first without ever returning key material", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    yield* pinPeer({ environmentId: "environment-late", firstSeenAtMillis: 3_000 });
    yield* pinPeer({
      environmentId: "environment-early",
      firstSeenAtMillis: 1_000,
      encryptionPublicKey: "encryption-key-for-tests",
    });

    const page = yield* store.listMeshPeers(10);

    assert.isFalse(page.truncated);
    assert.deepEqual(
      page.peers.map((peer) => peer.environmentId),
      ["environment-early", "environment-late"],
    );
    // The encryption key is reported as a capability flag only.
    assert.deepEqual(
      page.peers.map((peer) => peer.sealedDeliveryReady),
      [true, false],
    );
    assert.deepEqual(
      page.peers.map((peer) => peer.firstSeenAtMillis),
      [1_000, 3_000],
    );
    for (const peer of page.peers) {
      assert.deepEqual(Object.keys(peer).toSorted(), [
        "binding",
        "environmentId",
        "firstSeenAtMillis",
        "sealedDeliveryReady",
        "workspaceId",
      ]);
      // Rows inserted without a `key_binding` take migration 049's default,
      // which is the honest label for how they were actually pinned.
      assert.equal(peer.binding, "tofu");
      assert.equal(peer.workspaceId, WORKSPACE);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("returns an empty, untruncated page when nothing has been pinned yet", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    const page = yield* store.listMeshPeers(10);
    assert.deepEqual(page.peers, []);
    assert.isFalse(page.truncated);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("bounds the page and reports truncation instead of dumping the table", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;
    for (let index = 0; index < 5; index += 1) {
      yield* pinPeer({
        environmentId: `environment-${index}`,
        firstSeenAtMillis: 1_000 + index,
      });
    }

    const bounded = yield* store.listMeshPeers(2);
    assert.equal(bounded.peers.length, 2);
    assert.isTrue(bounded.truncated);

    // A nonsensical limit is clamped rather than trusted: never zero rows, and
    // never more than the contract bound.
    const clampedLow = yield* store.listMeshPeers(0);
    assert.equal(clampedLow.peers.length, 1);
    assert.isTrue(clampedLow.truncated);

    const clampedHigh = yield* store.listMeshPeers(Number.MAX_SAFE_INTEGER);
    assert.equal(clampedHigh.peers.length, 5);
    assert.isFalse(clampedHigh.truncated);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("surfaces an undecodable peer pin row as a typed corrupt-row error", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* WorkjetMailboxStore;
    yield* pinPeer({ environmentId: "environment-broken", firstSeenAtMillis: 1_000 });
    yield* sql`
      UPDATE workjet_mailbox_peer_keys
      SET source_environment_id = ''
      WHERE source_environment_id = 'environment-broken'
    `;

    const corrupt = yield* store.listMeshPeers(10).pipe(Effect.result);
    assert.equal(corrupt._tag, "Failure");
    if (corrupt._tag === "Failure") {
      assert.isTrue(isWorkjetMailboxStoreCorruptRowError(corrupt.failure));
    }
  }).pipe(Effect.provide(testLayer)),
);
