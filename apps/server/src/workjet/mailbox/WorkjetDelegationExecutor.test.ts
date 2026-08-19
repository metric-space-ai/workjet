// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics preferSchemaOverJson:off -- redaction assertions inspect complete bounded activity payloads.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  WorkjetContentDigest,
  WorkjetDelegationId,
  WorkjetEnvelopeId,
  WorkjetMeshWorkspaceId,
  WorkjetRepositoryPath,
  type OrchestrationCommand,
  type OrchestrationThread,
  type WorkjetDelegation,
  type WorkjetDelegationState,
  type WorkjetMailboxTimestamp,
  type WorkjetPayloadByteLength,
  type WorkjetWorkerAddress,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  delegationResultEnvelopeId,
  delegationTurnCommandId,
  delegationTurnMessageId,
  makeWorkjetDelegationExecutorWithSources,
  threadHasActiveTurn,
  WORKJET_DELEGATION_REFUSED_ACTIVITY_KIND,
  WORKJET_DELEGATION_RESULT_ACTIVITY_KIND,
  WORKJET_DELEGATION_STARTED_ACTIVITY_KIND,
  type WorkjetDelegationExecutorShape,
  type WorkjetDelegationExecutorSources,
} from "./WorkjetDelegationExecutor.ts";
import { WorkjetMailboxStore, WorkjetMailboxStoreLive } from "./WorkjetMailboxStore.ts";
import { WorkjetMeshIdentity } from "./WorkjetMeshIdentity.ts";
import {
  snapshotRefForDigest,
  WorkjetSnapshotStore,
  WorkjetSnapshotStoreLive,
} from "./WorkjetSnapshotStore.ts";

const WORKSPACE = WorkjetMeshWorkspaceId.make("workjet-mesh-room-1");
const LOCAL_ENVIRONMENT = EnvironmentId.make("environment-local");
const REMOTE_ENVIRONMENT = EnvironmentId.make("environment-remote");
const SOURCE_THREAD = ThreadId.make("thread-source");
const TARGET_THREAD = ThreadId.make("thread-target");

const NOW = "2026-08-19T12:00:00.000Z" as WorkjetMailboxTimestamp;
const LATER = "2026-08-19T12:00:30.000Z" as WorkjetMailboxTimestamp;
const EXPIRES = "2026-08-19T14:00:00.000Z" as WorkjetMailboxTimestamp;

const PROMPT_TEXT = "Implement the delegation executor.\nAcceptance: the focused suite is green.";

const address = (environmentId: EnvironmentId, threadId: ThreadId): WorkjetWorkerAddress => ({
  schemaVersion: 1,
  workspaceId: WORKSPACE,
  environmentId,
  threadId,
});

const delegationFixture = (input: {
  readonly id: string;
  readonly digest: WorkjetContentDigest;
  readonly state: WorkjetDelegationState;
  readonly sourceEnvironmentId?: EnvironmentId;
  readonly targetEnvironmentId?: EnvironmentId;
  readonly targetThreadId?: ThreadId;
  readonly stateChangedAt?: WorkjetMailboxTimestamp;
}): WorkjetDelegation => ({
  schemaVersion: 1,
  envelopeId: WorkjetEnvelopeId.make(`wjm-envelope-${input.id}-0000000000`),
  delegationId: WorkjetDelegationId.make(`wjd-${input.id.padEnd(24, "0")}`),
  source: address(input.sourceEnvironmentId ?? LOCAL_ENVIRONMENT, SOURCE_THREAD),
  target: address(
    input.targetEnvironmentId ?? LOCAL_ENVIRONMENT,
    input.targetThreadId ?? TARGET_THREAD,
  ),
  createdAt: NOW,
  expiresAt: EXPIRES,
  prompt: {
    schemaVersion: 1,
    // The honest reference for this digest, so the fixture is a delegation the
    // snapshot store itself could have produced.
    snapshotRef: snapshotRefForDigest(input.digest),
    digest: input.digest,
    byteLength: 64 as WorkjetPayloadByteLength,
  },
  scope: {
    schemaVersion: 1,
    files: [
      WorkjetRepositoryPath.make("apps/server/src/workjet/mailbox/WorkjetDelegationExecutor.ts"),
    ],
    nonGoals: "No transport, no result reporting.",
  },
  completion: { schemaVersion: 1, acceptance: "The focused suite is green." },
  budget: { schemaVersion: 1, maxDepth: 4, maxReviewRounds: 2, expiresAt: EXPIRES },
  state: input.state,
  stateChangedAt: input.stateChangedAt ?? NOW,
  depth: 0,
});

const thread = (input?: {
  readonly role?: "standard" | "orchestrator" | "worker";
  readonly busy?: boolean;
  readonly deleted?: boolean;
}): OrchestrationThread =>
  ({
    id: TARGET_THREAD,
    deletedAt: input?.deleted === true ? NOW : null,
    runtimeMode: "interactive",
    interactionMode: "chat",
    workjetConfig: { schemaVersion: 1, role: input?.role ?? "worker", enabledCapabilityIds: [] },
    latestTurn:
      input?.busy === true
        ? { turnId: "turn-1", state: "running", requestedAt: NOW, startedAt: NOW }
        : null,
    session: null,
  }) as unknown as OrchestrationThread;

/**
 * A target thread whose dispatched delegation turn has ENDED. The user message
 * the executor wrote is present with its `turnId`, and `latestTurn` reflects a
 * terminal turn; `latestTurnId` overrides it to model a DIFFERENT turn ending.
 */
const endedTurnThread = (input: {
  readonly delegationId: WorkjetDelegationId;
  readonly turnId: string;
  readonly turnState: "completed" | "error" | "interrupted";
  readonly latestTurnId?: string;
  readonly activeTurnId?: string | null;
}): OrchestrationThread =>
  ({
    ...thread(),
    messages: [
      {
        id: delegationTurnMessageId(input.delegationId),
        role: "user",
        text: "",
        turnId: input.turnId,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    latestTurn: {
      turnId: input.latestTurnId ?? input.turnId,
      state: input.turnState,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    },
    session: input.activeTurnId === undefined ? null : { activeTurnId: input.activeTurnId },
  }) as unknown as OrchestrationThread;

/**
 * A mesh-identity double: only `workspaceId` and `signRoutingEnvelope` are read
 * by the executor (to sign a cross-environment result envelope). The signature
 * is a fixed base64url stub — the store never verifies it and the transport
 * slice that would is out of scope here.
 */
const identityDouble = {
  workspaceId: WORKSPACE,
  signRoutingEnvelope: (envelope: unknown) =>
    Effect.succeed({ ...(envelope as Record<string, unknown>), signature: "c2lnbmF0dXJlLXN0dWI" }),
} as unknown as WorkjetMeshIdentity["Service"];

/** A dispatch failure shaped like the engine's own tagged errors. */
const retryableEngineError = {
  _tag: "PersistenceSqlError",
  message: "database is locked",
} as const;
const nonRetryableEngineError = {
  _tag: "OrchestrationCommandInvariantError",
  message: "thread does not exist",
} as const;

interface Harness {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly setThread: (next: OrchestrationThread | undefined) => void;
  readonly failNextTurnStarts: (count: number, error: { readonly _tag: string }) => void;
  readonly failThreadReads: (fail: boolean) => void;
  readonly executor: Effect.Effect<
    WorkjetDelegationExecutorShape,
    never,
    WorkjetMailboxStore | WorkjetSnapshotStore
  >;
}

/**
 * One in-memory database, one real content-addressed snapshot store, and a
 * recording engine, so the durable transitions AND the dispatched commands are
 * asserted exactly. Only the engine and the projection read are doubles: the
 * store's transition table is the invariant under test and is never faked.
 */
const makeHarness = (options?: {
  readonly initialThread?: OrchestrationThread | undefined;
  readonly nowValues?: ReadonlyArray<string>;
}): Harness => {
  const commands: Array<OrchestrationCommand> = [];
  let currentThread: OrchestrationThread | undefined =
    options && "initialThread" in options ? options.initialThread : thread();
  let turnStartFailures = 0;
  let turnStartError: { readonly _tag: string } = retryableEngineError;
  let threadReadsFail = false;
  let nowIndex = 0;
  const nowValues = options?.nowValues ?? [NOW];

  const sources: WorkjetDelegationExecutorSources = {
    nowIso: Effect.sync(() => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? NOW),
    environmentId: Effect.succeed(LOCAL_ENVIRONMENT),
  };

  const engine = {
    dispatch: (command: OrchestrationCommand) => {
      if (command.type === "thread.turn.start" && turnStartFailures > 0) {
        turnStartFailures -= 1;
        return Effect.fail(turnStartError);
      }
      commands.push(command);
      return Effect.succeed({ sequence: commands.length });
    },
  } as unknown as OrchestrationEngineService["Service"];

  const query = {
    getThreadDetailById: () =>
      threadReadsFail
        ? Effect.fail({ _tag: "ProjectionRepositoryError" } as const)
        : Effect.succeed(currentThread === undefined ? Option.none() : Option.some(currentThread)),
  } as unknown as ProjectionSnapshotQuery["Service"];

  return {
    commands,
    setThread: (next) => {
      currentThread = next;
    },
    failNextTurnStarts: (count, error) => {
      turnStartFailures = count;
      turnStartError = error;
    },
    failThreadReads: (fail) => {
      threadReadsFail = fail;
    },
    executor: makeWorkjetDelegationExecutorWithSources(sources).pipe(
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(ProjectionSnapshotQuery, query),
      Effect.provideService(WorkjetMeshIdentity, identityDouble),
    ),
  };
};

const testLayer = (prefix: string) =>
  Layer.mergeAll(
    WorkjetMailboxStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
    WorkjetSnapshotStoreLive.pipe(
      Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix }))),
      Layer.provide(NodeServices.layer),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));

/** Stores the prompt and returns the digest a delegation may legitimately pin. */
const storePrompt = Effect.fn("test.storePrompt")(function* (text: string) {
  const snapshots = yield* WorkjetSnapshotStore;
  const stored = yield* snapshots.put(text);
  return stored.digest;
});

const seed = Effect.fn("test.seed")(function* (delegation: WorkjetDelegation) {
  const store = yield* WorkjetMailboxStore;
  yield* store.upsertDelegation(delegation);
  return delegation;
});

const stateOf = Effect.fn("test.stateOf")(function* (delegation: WorkjetDelegation) {
  const store = yield* WorkjetMailboxStore;
  const record = yield* store.getDelegation(delegation.delegationId);
  return Option.getOrThrow(record).state;
});

const turnStarts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "thread.turn.start");

const activityKinds = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.activity.append" ? [command.activity.kind] : [],
  );

// ===============================
// Active-turn predicate
// ===============================

it("treats both a running latest turn and a live session as an active turn", () => {
  assert.isFalse(threadHasActiveTurn(thread()));
  assert.isTrue(threadHasActiveTurn(thread({ busy: true })));
  assert.isTrue(
    threadHasActiveTurn({
      ...thread(),
      session: { activeTurnId: "turn-9" },
    } as unknown as OrchestrationThread),
  );
  assert.isFalse(
    threadHasActiveTurn({
      ...thread(),
      latestTurn: { turnId: "turn-9", state: "completed" },
      session: { activeTurnId: null },
    } as unknown as OrchestrationThread),
  );
});

// ===============================
// Happy path
// ===============================

it.effect("runs a delivered delegation as a normal turn carrying the snapshot text", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(delegationFixture({ id: "happy", digest, state: "delivered" }));

    const status = yield* executor.runCycle;

    assert.equal(status.executed, 1);
    assert.equal(status.backpressure, 0);
    assert.equal(status.missingSnapshot, 0);
    assert.equal(status.cycles, 1);
    assert.equal(status.lastCycleAt, NOW);

    // delivered → accepted → running, ending in the state the plan names.
    assert.equal(yield* stateOf(delegation), "running");

    const starts = turnStarts(harness.commands);
    assert.equal(starts.length, 1);
    const start = starts[0];
    assert.isDefined(start);
    if (start === undefined || start.type !== "thread.turn.start") return;
    // The prompt is the SNAPSHOT's verified bytes, not anything the delegation
    // carried inline.
    assert.equal(start.message.text, PROMPT_TEXT);
    assert.equal(start.message.role, "user");
    assert.equal(start.threadId, TARGET_THREAD);
    // Derived ids: a retry after a restart is the same command, never a second turn.
    assert.equal(start.commandId, delegationTurnCommandId(delegation.delegationId));
    assert.equal(start.message.messageId, delegationTurnMessageId(delegation.delegationId));

    assert.deepEqual(activityKinds(harness.commands), [WORKJET_DELEGATION_STARTED_ACTIVITY_KIND]);
    const activity = harness.commands.find((command) => command.type === "thread.activity.append");
    if (activity === undefined || activity.type !== "thread.activity.append") return;
    // Bounded payload: ids and lifecycle only, never the prompt.
    assert.notInclude(JSON.stringify(activity.activity.payload), PROMPT_TEXT);
  }).pipe(Effect.provide(testLayer("delegation-executor-happy"))),
);

it.effect("executes a standard-role target and refuses an orchestrator target", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ initialThread: thread({ role: "standard" }) });
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const standard = yield* seed(delegationFixture({ id: "standard", digest, state: "delivered" }));

    assert.equal((yield* executor.runCycle).executed, 1);
    assert.equal(yield* stateOf(standard), "running");

    harness.setThread(thread({ role: "orchestrator" }));
    const refused = yield* seed(
      delegationFixture({ id: "orchestrator", digest, state: "delivered" }),
    );

    const status = yield* executor.runCycle;
    assert.equal(status.failures.targetRoleNotExecutable, 1);
    // Terminal: an orchestrator seat never becomes a delegation target, so the
    // row must not loop forever.
    assert.equal(yield* stateOf(refused), "failed");
    assert.equal(turnStarts(harness.commands).length, 1);
    assert.include(activityKinds(harness.commands), WORKJET_DELEGATION_REFUSED_ACTIVITY_KIND);
  }).pipe(Effect.provide(testLayer("delegation-executor-roles"))),
);

// ===============================
// Backpressure
// ===============================

it.effect("holds a delegation in delivered while the target turn runs, then executes it", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      initialThread: thread({ busy: true }),
      nowValues: [NOW, LATER],
    });
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(delegationFixture({ id: "busy", digest, state: "delivered" }));

    const busyStatus = yield* executor.runCycle;
    assert.equal(busyStatus.backpressure, 1);
    assert.equal(busyStatus.executed, 0);
    // The `delivered` row IS the queue; no second queue table exists.
    assert.equal(yield* stateOf(delegation), "delivered");
    assert.equal(turnStarts(harness.commands).length, 0);

    harness.setThread(thread());
    const readyStatus = yield* executor.runCycle;
    assert.equal(readyStatus.executed, 1);
    assert.equal(readyStatus.backpressure, 1);
    assert.equal(yield* stateOf(delegation), "running");
    assert.equal(turnStarts(harness.commands).length, 1);
  }).pipe(Effect.provide(testLayer("delegation-executor-backpressure"))),
);

it.effect("starts only one turn per thread per cycle even with two delivered delegations", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const first = yield* seed(
      delegationFixture({ id: "order-a", digest, state: "delivered", stateChangedAt: NOW }),
    );
    const second = yield* seed(
      delegationFixture({ id: "order-b", digest, state: "delivered", stateChangedAt: LATER }),
    );

    const status = yield* executor.runCycle;

    // Per-delegation ordering falls out of the store's `stateChangedAt ASC`
    // scan; the projection has not caught up within one cycle, so the second
    // row is held by the executor's own in-cycle busy set.
    assert.equal(status.executed, 1);
    assert.equal(status.backpressure, 1);
    assert.equal(yield* stateOf(first), "running");
    assert.equal(yield* stateOf(second), "delivered");
    assert.equal(turnStarts(harness.commands).length, 1);
  }).pipe(Effect.provide(testLayer("delegation-executor-ordering"))),
);

// ===============================
// Snapshot availability
// ===============================

it.effect("skips a delegation whose prompt snapshot is not stored on this machine", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    // A remote inbound delegation pins a digest whose BYTES live on the source
    // machine; cross-machine snapshot transfer is a later slice.
    const absent = WorkjetContentDigest.make("f".repeat(64));
    const delegation = yield* seed(
      delegationFixture({ id: "nosnapshot", digest: absent, state: "delivered" }),
    );

    const status = yield* executor.runCycle;

    assert.equal(status.missingSnapshot, 1);
    assert.equal(status.executed, 0);
    assert.equal(status.failures.engineRejected, 0);
    // Counted and retried later, NEVER failed: the delegation is valid, only
    // its bytes are elsewhere. The prompt is resolved BEFORE the accept, so the
    // row stays exactly where it was.
    assert.equal(yield* stateOf(delegation), "delivered");
    assert.equal(turnStarts(harness.commands).length, 0);
  }).pipe(Effect.provide(testLayer("delegation-executor-nosnapshot"))),
);

it.effect("skips a delegation whose target thread lives in another environment", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(
      delegationFixture({
        id: "foreign",
        digest,
        state: "delivered",
        targetEnvironmentId: REMOTE_ENVIRONMENT,
      }),
    );

    const status = yield* executor.runCycle;

    assert.equal(status.foreignEnvironment, 1);
    assert.equal(status.executed, 0);
    assert.equal(yield* stateOf(delegation), "delivered");
  }).pipe(Effect.provide(testLayer("delegation-executor-foreign"))),
);

// ===============================
// Restart resume
// ===============================

it.effect("resumes rows a previous process left in delivered and in accepted", () =>
  Effect.gen(function* () {
    const digest = yield* storePrompt(PROMPT_TEXT);
    // A previous process wrote these rows and then died. The harness below is a
    // FRESH executor, exactly as a restarted server would build one.
    const leftAccepted = yield* seed(
      delegationFixture({ id: "resume-a", digest, state: "accepted", stateChangedAt: NOW }),
    );
    const leftDelivered = yield* seed(
      delegationFixture({ id: "resume-d", digest, state: "delivered", stateChangedAt: LATER }),
    );

    const harness = makeHarness();
    const executor = yield* harness.executor;

    // The FIRST cycle after construction is the resume. `accepted` is drained
    // before `delivered`, so the half-started row finishes first and the
    // delivered row waits behind it on the same thread.
    const first = yield* executor.runCycle;
    assert.equal(first.scanned, 2);
    assert.equal(first.executed, 1);
    assert.equal(first.backpressure, 1);
    assert.equal(yield* stateOf(leftAccepted), "running");
    assert.equal(yield* stateOf(leftDelivered), "delivered");

    const second = yield* executor.runCycle;
    assert.equal(second.executed, 2);
    assert.equal(yield* stateOf(leftDelivered), "running");
    assert.equal(turnStarts(harness.commands).length, 2);
  }).pipe(Effect.provide(testLayer("delegation-executor-resume"))),
);

it.effect("retries an accepted row with the same command id after a transient rejection", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(delegationFixture({ id: "retry", digest, state: "delivered" }));

    harness.failNextTurnStarts(1, retryableEngineError);
    const failedCycle = yield* executor.runCycle;
    assert.equal(failedCycle.dispatchRetries, 1);
    assert.equal(failedCycle.executed, 0);
    // No `accepted → delivered` edge exists, so the row waits in `accepted`.
    assert.equal(yield* stateOf(delegation), "accepted");
    assert.equal(turnStarts(harness.commands).length, 0);

    const retryCycle = yield* executor.runCycle;
    assert.equal(retryCycle.executed, 1);
    assert.equal(yield* stateOf(delegation), "running");
    const starts = turnStarts(harness.commands);
    assert.equal(starts.length, 1);
    const start = starts[0];
    if (start === undefined || start.type !== "thread.turn.start") return;
    // The retry reuses the derived command id, so the engine's own receipts
    // make a duplicate turn unrepresentable.
    assert.equal(start.commandId, delegationTurnCommandId(delegation.delegationId));
  }).pipe(Effect.provide(testLayer("delegation-executor-retry"))),
);

it.effect("fails a delegation the engine rejects for a non-retryable reason", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(
      delegationFixture({ id: "invariant", digest, state: "delivered" }),
    );

    harness.failNextTurnStarts(4, nonRetryableEngineError);
    const status = yield* executor.runCycle;

    assert.equal(status.failures.engineRejected, 1);
    assert.equal(status.dispatchRetries, 0);
    assert.equal(yield* stateOf(delegation), "failed");
  }).pipe(Effect.provide(testLayer("delegation-executor-invariant"))),
);

// ===============================
// Target and terminal rows
// ===============================

it.effect("fails a delegation whose target thread is gone and one that was deleted", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ initialThread: undefined });
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const missing = yield* seed(delegationFixture({ id: "missing", digest, state: "delivered" }));

    assert.equal((yield* executor.runCycle).failures.targetThreadMissing, 1);
    assert.equal(yield* stateOf(missing), "failed");

    harness.setThread(thread({ deleted: true }));
    const deleted = yield* seed(delegationFixture({ id: "deleted", digest, state: "delivered" }));
    assert.equal((yield* executor.runCycle).failures.targetThreadDeleted, 1);
    assert.equal(yield* stateOf(deleted), "failed");
    assert.equal(turnStarts(harness.commands).length, 0);
  }).pipe(Effect.provide(testLayer("delegation-executor-target"))),
);

it.effect("never consumes a delegation when the projection read fails", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(
      delegationFixture({ id: "transient", digest, state: "delivered" }),
    );

    harness.failThreadReads(true);
    const status = yield* executor.runCycle;
    assert.equal(status.transientSkips, 1);
    assert.equal(status.failures.targetThreadMissing, 0);
    assert.equal(yield* stateOf(delegation), "delivered");

    harness.failThreadReads(false);
    assert.equal((yield* executor.runCycle).executed, 1);
    assert.equal(yield* stateOf(delegation), "running");
  }).pipe(Effect.provide(testLayer("delegation-executor-transient"))),
);

it.effect("leaves terminal and unfinished delegations untouched", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const completed = yield* seed(
      delegationFixture({ id: "completed", digest, state: "completed" }),
    );
    const failed = yield* seed(delegationFixture({ id: "failed", digest, state: "failed" }));
    const queued = yield* seed(delegationFixture({ id: "queued", digest, state: "queued" }));
    const running = yield* seed(delegationFixture({ id: "running", digest, state: "running" }));

    const status = yield* executor.runCycle;

    // Only the `running` row is scanned now (`queued` belongs to delivery, the
    // two terminal rows to nobody). Its default target thread has no ended turn
    // to correlate, so it is held pending, not completed.
    assert.equal(status.scanned, 1);
    assert.equal(status.runningPending, 1);
    assert.equal(status.completed, 0);
    assert.equal(status.executed, 0);
    assert.equal(turnStarts(harness.commands).length, 0);
    assert.equal(yield* stateOf(completed), "completed");
    assert.equal(yield* stateOf(failed), "failed");
    assert.equal(yield* stateOf(queued), "queued");
    assert.equal(yield* stateOf(running), "running");
  }).pipe(Effect.provide(testLayer("delegation-executor-terminal"))),
);

// ===============================
// Result return (running → terminal)
// ===============================

it.effect("completes a running delegation whose dispatched turn ended and returns the result", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "done",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
    });
    const harness = makeHarness({
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-done",
        turnState: "completed",
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    assert.equal(status.completed, 1);
    assert.equal(status.turnFailures, 0);
    assert.equal(status.resultsReturned, 1);
    assert.equal(status.resultsEnqueued, 0);
    assert.equal(yield* stateOf(delegation), "completed");

    // The result activity lands on the SOURCE thread, bounded and prompt-free.
    const activities = harness.commands.filter(
      (command) => command.type === "thread.activity.append",
    );
    const resultActivity = activities.find(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === WORKJET_DELEGATION_RESULT_ACTIVITY_KIND,
    );
    assert.isDefined(resultActivity);
    if (resultActivity === undefined || resultActivity.type !== "thread.activity.append") return;
    assert.equal(resultActivity.threadId, SOURCE_THREAD);
    assert.notInclude(JSON.stringify(resultActivity.activity.payload), PROMPT_TEXT);

    // The result is persisted on the row so a late completion returns the same one.
    const store = yield* WorkjetMailboxStore;
    const stored = yield* store.getDelegationResult(delegation.delegationId);
    assert.isTrue(Option.isSome(stored));
    if (Option.isNone(stored)) return;
    assert.equal(stored.value.outcome, "completed");
    assert.equal(stored.value.envelopeId, delegationResultEnvelopeId(delegation.delegationId));
    assert.deepEqual([...stored.value.artifacts.commitHashes], []);
    assert.deepEqual([...stored.value.artifacts.paths], []);
  }).pipe(Effect.provide(testLayer("delegation-executor-result-completed"))),
);

it.effect("fails a running delegation whose dispatched turn ended in error", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "err",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
    });
    const harness = makeHarness({
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-err",
        turnState: "error",
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    assert.equal(status.turnFailures, 1);
    assert.equal(status.completed, 0);
    assert.equal(status.resultsReturned, 1);
    assert.equal(yield* stateOf(delegation), "failed");

    const store = yield* WorkjetMailboxStore;
    const stored = yield* store.getDelegationResult(delegation.delegationId);
    assert.isTrue(Option.isSome(stored));
    if (Option.isNone(stored)) return;
    assert.equal(stored.value.outcome, "failed");
  }).pipe(Effect.provide(testLayer("delegation-executor-result-failed"))),
);

it.effect("does NOT complete a running delegation when a DIFFERENT turn ended", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "wrongturn",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
    });
    const harness = makeHarness({
      // Our dispatched message maps to `turn-ours`, but the latest ended turn is
      // an unrelated `turn-other`: the delegation must NOT be completed on it.
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-ours",
        turnState: "completed",
        latestTurnId: "turn-other",
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    assert.equal(status.completed, 0);
    assert.equal(status.turnFailures, 0);
    assert.equal(status.runningPending, 1);
    assert.equal(status.resultsReturned, 0);
    assert.equal(yield* stateOf(delegation), "running");

    const store = yield* WorkjetMailboxStore;
    assert.isTrue(Option.isNone(yield* store.getDelegationResult(delegation.delegationId)));
  }).pipe(Effect.provide(testLayer("delegation-executor-wrongturn"))),
);

it.effect("does NOT complete while the session still drives the dispatched turn", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "stilllive",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
    });
    const harness = makeHarness({
      // The latest-turn projection reads terminal, but the session still names
      // our turn as active: wait for it to clear rather than racing it.
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-live",
        turnState: "completed",
        activeTurnId: "turn-live",
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    assert.equal(status.completed, 0);
    assert.equal(status.runningPending, 1);
    assert.equal(yield* stateOf(delegation), "running");
  }).pipe(Effect.provide(testLayer("delegation-executor-stilllive"))),
);

it.effect("enqueues a result envelope outbound for a cross-environment source", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "crossenv",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
      // The SOURCE lives on another machine; the TARGET (this worker) is local.
      sourceEnvironmentId: REMOTE_ENVIRONMENT,
    });
    const harness = makeHarness({
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-cross",
        turnState: "completed",
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    assert.equal(status.completed, 1);
    assert.equal(status.resultsEnqueued, 1);
    // A cross-environment source has no local thread to append onto.
    assert.equal(status.resultsReturned, 0);
    assert.equal(yield* stateOf(delegation), "completed");

    const store = yield* WorkjetMailboxStore;
    const outbound = yield* store.getOutbound(delegationResultEnvelopeId(delegation.delegationId));
    assert.isTrue(Option.isSome(outbound));
    if (Option.isNone(outbound)) return;
    assert.equal(outbound.value.envelope.kind, "result");
    assert.equal(outbound.value.envelope.targetEnvironmentId, REMOTE_ENVIRONMENT);
    assert.equal(outbound.value.state, "pending");
    // No result activity is appended for a remote source.
    assert.notInclude(activityKinds(harness.commands), WORKJET_DELEGATION_RESULT_ACTIVITY_KIND);
  }).pipe(Effect.provide(testLayer("delegation-executor-crossenv"))),
);
