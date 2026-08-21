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
  WorkjetMailboxError,
  WorkjetMeshWorkspaceId,
  WorkjetRepositoryPath,
  type OrchestrationCommand,
  type OrchestrationThread,
  type WorkjetGitCommitHash,
  type WorkjetDelegation,
  type WorkjetDelegationRef,
  type WorkjetDelegationState,
  type WorkjetMailboxPayload,
  type WorkjetMailboxTimestamp,
  type WorkjetPayloadByteLength,
  type WorkjetRoutingEnvelope,
  type WorkjetWorkerAddress,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  delegationResultEnvelopeId,
  delegationTurnCommandId,
  delegationTurnInterruptCommandId,
  delegationTurnMessageId,
  makeWorkjetDelegationExecutorWithSources,
  threadHasActiveTurn,
  turnTokenUsage,
  WORKJET_DELEGATION_REFUSED_ACTIVITY_KIND,
  WORKJET_DELEGATION_RESULT_ACTIVITY_KIND,
  WORKJET_DELEGATION_STARTED_ACTIVITY_KIND,
  type WorkjetDelegationExecutorShape,
  type WorkjetDelegationExecutorSources,
} from "./WorkjetDelegationExecutor.ts";
import {
  isWorkjetMailboxError,
  WorkjetMailboxStore,
  WorkjetMailboxStoreLive,
  WORKJET_MAILBOX_MAX_DELIVERY_ATTEMPTS,
} from "./WorkjetMailboxStore.ts";
import type { WorkjetMailboxAuditEventInput } from "./WorkjetMailboxAuditEmitter.ts";
import {
  makeWorkjetMailboxRpcHandlers,
  type WorkjetMailboxRpcDependencies,
} from "./WorkjetMailboxRpc.ts";
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
  readonly requiresApproval?: boolean;
  readonly maxTokens?: number;
  readonly maxCostMicros?: number;
  /** A review/revise chain link, whose `owner` is the parent's TARGET thread. */
  readonly parent?: WorkjetDelegationRef;
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
  budget: {
    schemaVersion: 1,
    maxDepth: 4,
    maxReviewRounds: 2,
    expiresAt: EXPIRES,
    ...(input.requiresApproval === true ? { requiresApproval: true } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.maxCostMicros !== undefined ? { maxCostMicros: input.maxCostMicros } : {}),
  },
  state: input.state,
  stateChangedAt: input.stateChangedAt ?? NOW,
  depth: 0,
  ...(input.parent === undefined ? {} : { parent: input.parent }),
});

const thread = (input?: {
  readonly role?: "standard" | "orchestrator" | "worker";
  readonly busy?: boolean;
  readonly deleted?: boolean;
  readonly id?: ThreadId;
  readonly capabilityIds?: ReadonlyArray<string>;
  readonly worktreePath?: string;
}): OrchestrationThread =>
  ({
    id: input?.id ?? TARGET_THREAD,
    deletedAt: input?.deleted === true ? NOW : null,
    runtimeMode: "interactive",
    interactionMode: "chat",
    workjetConfig: {
      schemaVersion: 1,
      role: input?.role ?? "worker",
      enabledCapabilityIds: input?.capabilityIds ?? [],
    },
    latestTurn:
      input?.busy === true
        ? { turnId: "turn-1", state: "running", requestedAt: NOW, startedAt: NOW }
        : null,
    session: null,
    ...(input?.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
  }) as unknown as OrchestrationThread;

/**
 * One `context-window.updated` thread activity, the shape the provider-runtime
 * ingestion appends for a `thread.token-usage.updated` runtime event. This is
 * the only per-turn token source the executor can reach, so the usage tests
 * feed it exactly as the projection would.
 */
const usageActivity = (input: {
  readonly index: number;
  readonly turnId: string | null;
  readonly tokens: number;
}) => ({
  id: `usage-${input.index}`,
  tone: "info",
  kind: "context-window.updated",
  summary: "Context window updated",
  payload: { usedTokens: input.tokens, totalProcessedTokens: input.tokens },
  turnId: input.turnId,
  createdAt: NOW,
});

/**
 * A target thread whose dispatched delegation turn is STILL RUNNING, carrying
 * the usage activities observed so far. Mid-run budget enforcement reads
 * exactly this shape.
 */
const runningTurnThread = (input: {
  readonly delegationId: WorkjetDelegationId;
  readonly turnId: string;
  readonly activities?: ReadonlyArray<unknown>;
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
      turnId: input.turnId,
      state: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
    },
    activities: input.activities ?? [],
    session: { activeTurnId: input.turnId },
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
  readonly activities?: ReadonlyArray<unknown>;
  readonly worktreePath?: string;
}): OrchestrationThread =>
  ({
    ...thread(input.worktreePath === undefined ? undefined : { worktreePath: input.worktreePath }),
    activities: input.activities ?? [],
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
  readonly events: ReadonlyArray<WorkjetMailboxAuditEventInput>;
  readonly setThread: (next: OrchestrationThread | undefined) => void;
  /**
   * Override the thread returned for ONE id. The default read answers with the
   * same thread whatever id it is handed, which is enough for every test that
   * only looks at the target; the parent-superset check reads a SECOND thread,
   * so it needs the two to be distinguishable.
   */
  readonly setThreadById: (threadId: ThreadId, next: OrchestrationThread) => void;
  readonly failNextTurnStarts: (count: number, error: { readonly _tag: string }) => void;
  readonly failThreadReads: (fail: boolean) => void;
  /**
   * Fail the read for ONE thread id only. The parent-superset check reads a
   * second thread AFTER the target read succeeds, so a blanket read failure
   * never reaches it.
   */
  readonly failThreadReadFor: (threadId: ThreadId) => void;
  /**
   * Make the NEXT `count` outbound enqueues fail. `transient` is a SQL-shaped
   * failure the reconciler must retry; `permanent` is the bounded mailbox
   * reason it must stop retrying on.
   */
  readonly failNextEnqueues: (count: number, kind: "transient" | "permanent") => void;
  /** Every `enqueueOutbound` call the executor made, failures included. */
  readonly enqueueAttempts: () => number;
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
  readonly failAudit?: boolean;
  /**
   * Force `recordDelegationUsage` to refuse with this reason. The executor
   * never produces a non-zero cost delta (no per-turn cost figure is projected
   * anywhere it can reach), so a `cost-budget-exceeded` refusal is the only way
   * to exercise the cost branch of the ceiling handling.
   */
  readonly refuseUsageCharge?: "token-budget-exceeded" | "cost-budget-exceeded";
  /**
   * Head commit the injected port reports, or the literal "explodes" to make
   * the port die — a delegation that already ran must survive either.
   */
  readonly headCommit?: string;
}): Harness => {
  const commands: Array<OrchestrationCommand> = [];
  const events: Array<WorkjetMailboxAuditEventInput> = [];
  let currentThread: OrchestrationThread | undefined =
    options && "initialThread" in options ? options.initialThread : thread();
  const threadsById = new Map<string, OrchestrationThread>();
  const unreadableThreadIds = new Set<string>();
  let turnStartFailures = 0;
  let turnStartError: { readonly _tag: string } = retryableEngineError;
  let threadReadsFail = false;
  let enqueueFailures = 0;
  let enqueueFailureKind: "transient" | "permanent" = "transient";
  let enqueueCalls = 0;
  let nowIndex = 0;
  const nowValues = options?.nowValues ?? [NOW];

  const sources: WorkjetDelegationExecutorSources = {
    nowIso: Effect.sync(() => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? NOW),
    environmentId: Effect.succeed(LOCAL_ENVIRONMENT),
    audit: {
      emit: (event) => {
        events.push(event);
        return options?.failAudit ? Effect.die("audit emitter exploded") : Effect.void;
      },
    },
    ...(options?.headCommit === undefined
      ? {}
      : {
          resolveHeadCommit: () =>
            options.headCommit === "explodes"
              ? Effect.die("git is unavailable")
              : Effect.succeed(Option.some(options.headCommit as WorkjetGitCommitHash)),
        }),
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
    getThreadDetailById: (threadId: ThreadId) => {
      if (threadReadsFail || unreadableThreadIds.has(threadId))
        return Effect.fail({ _tag: "ProjectionRepositoryError" } as const);
      const override = threadsById.get(threadId);
      if (override !== undefined) return Effect.succeed(Option.some(override));
      return Effect.succeed(
        currentThread === undefined ? Option.none() : Option.some(currentThread),
      );
    },
  } as unknown as ProjectionSnapshotQuery["Service"];

  return {
    commands,
    events,
    setThread: (next) => {
      currentThread = next;
    },
    setThreadById: (threadId, next) => {
      threadsById.set(threadId, next);
    },
    failNextTurnStarts: (count, error) => {
      turnStartFailures = count;
      turnStartError = error;
    },
    failThreadReads: (fail) => {
      threadReadsFail = fail;
    },
    failThreadReadFor: (threadId) => {
      unreadableThreadIds.add(threadId);
    },
    failNextEnqueues: (count, kind) => {
      enqueueFailures = count;
      enqueueFailureKind = kind;
    },
    enqueueAttempts: () => enqueueCalls,
    executor: Effect.gen(function* () {
      const base = makeWorkjetDelegationExecutorWithSources(sources).pipe(
        Effect.provideService(OrchestrationEngineService, engine),
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(WorkjetMeshIdentity, identityDouble),
      );
      const refusal = options?.refuseUsageCharge;
      const real = yield* WorkjetMailboxStore;
      // The REAL store, with only the two seams a test needs: a refused usage
      // charge and an outbound enqueue that fails. Everything durable — the
      // transition table, the result column, the migration-049 markers — stays
      // the production implementation.
      const instrumented = {
        ...real,
        ...(refusal === undefined
          ? {}
          : {
              recordDelegationUsage: () =>
                Effect.fail(new WorkjetMailboxError({ reason: refusal })),
            }),
        enqueueOutbound: (
          envelope: Parameters<WorkjetMailboxStore["Service"]["enqueueOutbound"]>[0],
          payload: Parameters<WorkjetMailboxStore["Service"]["enqueueOutbound"]>[1],
        ) => {
          enqueueCalls += 1;
          if (enqueueFailures > 0) {
            enqueueFailures -= 1;
            return enqueueFailureKind === "permanent"
              ? Effect.fail(new WorkjetMailboxError({ reason: "malformed-envelope" }))
              : // Shaped like the store's own SQL failure: NOT a bounded mailbox
                // reason, so the reconciler must classify it as retryable.
                Effect.fail(retryableEngineError as unknown as WorkjetMailboxError);
          }
          return real.enqueueOutbound(envelope, payload);
        },
      } as unknown as WorkjetMailboxStore["Service"];
      return yield* base.pipe(Effect.provideService(WorkjetMailboxStore, instrumented));
    }),
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

it.effect("holds a pending-approval delegation in delivered until it is approved", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const store = yield* WorkjetMailboxStore;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(
      delegationFixture({ id: "approval", digest, state: "delivered", requiresApproval: true }),
    );

    // The approval gate blocks acceptance: the row stays `delivered`, no turn is
    // dispatched, and the cycle counts it as awaiting approval.
    const gated = yield* executor.runCycle;
    assert.equal(gated.executed, 0);
    assert.equal(gated.awaitingApproval, 1);
    assert.equal(yield* stateOf(delegation), "delivered");
    assert.equal(turnStarts(harness.commands).length, 0);

    // A human approves it; the very next cycle runs it as a normal turn.
    yield* store.setDelegationApproval(delegation.delegationId, true, NOW);
    const ran = yield* executor.runCycle;
    assert.equal(ran.executed, 1);
    // The counters are cumulative across cycles: the gate was hit once (cycle 1)
    // and not again (cycle 2), so the running total stays 1.
    assert.equal(ran.awaitingApproval, 1);
    assert.equal(yield* stateOf(delegation), "running");
    assert.equal(turnStarts(harness.commands).length, 1);
  }).pipe(Effect.provide(testLayer("delegation-executor-approval"))),
);

it.effect("never runs a rejected delegation", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const store = yield* WorkjetMailboxStore;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(
      delegationFixture({ id: "rejected", digest, state: "delivered", requiresApproval: true }),
    );

    // Rejection cancels the delegation terminally; the executor never touches it.
    yield* store.setDelegationApproval(delegation.delegationId, false, NOW);
    const status = yield* executor.runCycle;
    assert.equal(status.executed, 0);
    assert.equal(status.awaitingApproval, 0);
    assert.equal(yield* stateOf(delegation), "cancelled");
    assert.equal(turnStarts(harness.commands).length, 0);
  }).pipe(Effect.provide(testLayer("delegation-executor-rejected"))),
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
// Target-side capability check
// ===============================
// `WorkerDispatch` refuses a child whose requested capabilities exceed its
// parent's grants — but only at thread CREATION. A delegation targets a thread
// that already exists, so without this the invariant simply stops applying the
// moment a chain reaches an existing thread.

it.effect("refuses a delegation whose target holds a capability its parent does not", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ initialThread: thread({ capabilityIds: ["greppy"] }) });
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    // The delegating (parent) thread holds nothing. The target holds greppy.
    harness.setThreadById(SOURCE_THREAD, thread({ id: SOURCE_THREAD, role: "orchestrator" }));

    const escalating = yield* seed(
      delegationFixture({ id: "escalate", digest, state: "delivered" }),
    );

    const status = yield* executor.runCycle;

    assert.equal(status.failures.targetCapabilityEscalation, 1);
    assert.equal(status.executed, 0);
    // Terminal, like the role refusal: a thread's grants will not narrow while
    // the row waits, so looping would only postpone the same answer.
    assert.equal(yield* stateOf(escalating), "failed");
    assert.equal(turnStarts(harness.commands).length, 0);
    assert.include(activityKinds(harness.commands), WORKJET_DELEGATION_REFUSED_ACTIVITY_KIND);
  }).pipe(Effect.provide(testLayer("delegation-executor-capability-refuse"))),
);

it.effect("executes a target whose capabilities are a SUBSET of the parent's", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ initialThread: thread({ capabilityIds: ["greppy"] }) });
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    harness.setThreadById(
      SOURCE_THREAD,
      thread({ id: SOURCE_THREAD, role: "orchestrator", capabilityIds: ["greppy", "web-search"] }),
    );

    const allowed = yield* seed(delegationFixture({ id: "subset", digest, state: "delivered" }));

    const status = yield* executor.runCycle;

    // Narrower than the parent is the normal, correct case. A check that
    // refused it would break every capability-bearing worker.
    assert.equal(status.failures.targetCapabilityEscalation, 0);
    assert.equal(status.executed, 1);
    assert.equal(yield* stateOf(allowed), "running");
  }).pipe(Effect.provide(testLayer("delegation-executor-capability-subset"))),
);

it.effect("takes the grants from the PARENT DELEGATION when the chain names one", () =>
  Effect.gen(function* () {
    const REVIEW_PARENT_THREAD = ThreadId.make("thread-review-parent");
    const harness = makeHarness({ initialThread: thread({ capabilityIds: ["greppy"] }) });
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);

    // A review chain: the SOURCE thread is generous, but the delegation this
    // one descends from ran under a thread that holds nothing. The chain link
    // is the authority, or a review request would launder capabilities the
    // reviewed work never had.
    harness.setThreadById(
      SOURCE_THREAD,
      thread({ id: SOURCE_THREAD, role: "orchestrator", capabilityIds: ["greppy"] }),
    );
    harness.setThreadById(REVIEW_PARENT_THREAD, thread({ id: REVIEW_PARENT_THREAD }));

    const chained = yield* seed(
      delegationFixture({
        id: "chained",
        digest,
        state: "delivered",
        parent: {
          schemaVersion: 1,
          delegationId: WorkjetDelegationId.make("wjd-parent0000000000000000"),
          owner: address(LOCAL_ENVIRONMENT, REVIEW_PARENT_THREAD),
        },
      }),
    );

    const status = yield* executor.runCycle;

    assert.equal(status.failures.targetCapabilityEscalation, 1);
    assert.equal(yield* stateOf(chained), "failed");
  }).pipe(Effect.provide(testLayer("delegation-executor-capability-chain"))),
);

it.effect("fails closed when the parent thread is gone, and stays open when it is unreadable", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ initialThread: thread({ capabilityIds: ["greppy"] }) });
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    // A DELETED parent leaves no authority on record. The empty set is the only
    // defensible superset — running under a parent that no longer exists is
    // exactly what this check is for.
    harness.setThreadById(
      SOURCE_THREAD,
      thread({ id: SOURCE_THREAD, role: "orchestrator", deleted: true }),
    );

    const orphan = yield* seed(delegationFixture({ id: "orphan", digest, state: "delivered" }));
    const closed = yield* executor.runCycle;
    assert.equal(closed.failures.targetCapabilityEscalation, 1);
    assert.equal(yield* stateOf(orphan), "failed");

    // A projection HICCUP, by contrast, is not evidence about grants. It must
    // retry rather than terminally refuse work on a read that may succeed next
    // cycle.
    const retried = yield* seed(delegationFixture({ id: "retried", digest, state: "delivered" }));
    // Only the PARENT read fails. The target read still succeeds, so the guard
    // is genuinely reached with an unreadable parent rather than short-circuited
    // by the target read above it.
    harness.setThreadById(SOURCE_THREAD, thread({ id: SOURCE_THREAD, role: "orchestrator" }));
    harness.failThreadReadFor(SOURCE_THREAD);
    const transient = yield* executor.runCycle;
    // The counters are cumulative, so "no NEW refusal" is the claim: the
    // unreadable parent added nothing to the fail-closed count above.
    assert.equal(transient.failures.targetCapabilityEscalation, 1);
    assert.equal(yield* stateOf(retried), "delivered");
  }).pipe(Effect.provide(testLayer("delegation-executor-capability-orphan"))),
);

it.effect("cannot check a remote-rooted delegation, and says so by letting it run", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ initialThread: thread({ capabilityIds: ["greppy"] }) });
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);

    // The parent thread lives on another machine. This server holds no record
    // of its grants and could not verify a claim about them — the delegation
    // contract has no capability field, so any such claim would be
    // peer-supplied text. The remote path's real protection is that a peer
    // cannot CHOOSE the target's capabilities: they are whatever the local
    // operator already granted that thread. Documented here so a future reader
    // does not mistake this for an oversight.
    const remote = yield* seed(
      delegationFixture({
        id: "remoteroot",
        digest,
        state: "delivered",
        sourceEnvironmentId: EnvironmentId.make("environment-peer"),
      }),
    );

    const status = yield* executor.runCycle;
    assert.equal(status.failures.targetCapabilityEscalation, 0);
    assert.equal(yield* stateOf(remote), "running");
  }).pipe(Effect.provide(testLayer("delegation-executor-capability-remote"))),
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

it.effect("reports the target worktree's head commit as an artifact reference", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "headcommit",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
    });
    const harness = makeHarness({
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-headcommit",
        turnState: "completed",
        worktreePath: "/tmp/target-worktree",
      }),
      headCommit: "a1b2c3d4e5f6789",
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    yield* executor.runCycle;

    const store = yield* WorkjetMailboxStore;
    const stored = yield* store.getDelegationResult(delegation.delegationId);
    assert.isTrue(Option.isSome(stored));
    if (Option.isNone(stored)) return;

    assert.deepEqual([...stored.value.artifacts.commitHashes], ["a1b2c3d4e5f6789"]);
    // Still NO branch ref: WorkjetGitBranchRef REQUIRES a `delivery`, and this
    // executor neither pushes nor bundles, so naming one would send the source
    // after a branch it cannot fetch.
    assert.isUndefined(stored.value.artifacts.branch);
    assert.deepEqual([...stored.value.artifacts.paths], []);
  }).pipe(Effect.provide(testLayer("delegation-executor-headcommit"))),
);

it.effect("still completes when the head commit cannot be read", () =>
  Effect.gen(function* () {
    // A thread with no worktree, and a port that dies outright. The turn has
    // already run by then, so neither may turn a finished delegation into a
    // failure — the result simply carries no commit.
    const store = yield* WorkjetMailboxStore;
    for (const [id, worktreePath, headCommit] of [
      ["nocommitA", undefined, "a1b2c3d4e5f6789"],
      ["nocommitB", "/tmp/target-worktree", "explodes"],
    ] as const) {
      const delegation = delegationFixture({
        id,
        digest: yield* storePrompt(PROMPT_TEXT),
        state: "running",
      });
      const harness = makeHarness({
        initialThread: endedTurnThread({
          delegationId: delegation.delegationId,
          turnId: `turn-${id}`,
          turnState: "completed",
          ...(worktreePath === undefined ? {} : { worktreePath }),
        }),
        headCommit,
      });
      const executor = yield* harness.executor;
      yield* seed(delegation);

      yield* executor.runCycle;

      assert.equal(yield* stateOf(delegation), "completed", `${id} still completes`);
      const stored = yield* store.getDelegationResult(delegation.delegationId);
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.deepEqual([...stored.value.artifacts.commitHashes], [], `${id} reports no commit`);
    }
  }).pipe(Effect.provide(testLayer("delegation-executor-nocommit"))),
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

// ===============================
// Interruption (running → failed with turn-interrupted)
// ===============================

it.effect("fails a running delegation whose dispatched turn was interrupted", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "interrupted",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
    });
    const harness = makeHarness({
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-int",
        turnState: "interrupted",
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    // An interruption is an explicit, bounded terminal outcome — counted on its
    // own AND in the aggregate turn-failure total.
    assert.equal(status.turnInterrupted, 1);
    assert.equal(status.turnFailures, 1);
    assert.equal(status.completed, 0);
    assert.equal(status.resultsReturned, 1);
    assert.equal(yield* stateOf(delegation), "failed");

    // The persisted result names the interruption in its bounded summary.
    const store = yield* WorkjetMailboxStore;
    const stored = yield* store.getDelegationResult(delegation.delegationId);
    assert.isTrue(Option.isSome(stored));
    if (Option.isNone(stored)) return;
    assert.equal(stored.value.outcome, "failed");
    assert.equal(stored.value.summary, "Delegation turn was interrupted.");
  }).pipe(Effect.provide(testLayer("delegation-executor-interrupted"))),
);

// ===============================
// Deleted target thread mid-run (running → failed, not "reaped later")
// ===============================

it.effect("fails a running delegation whose target thread is deleted mid-run", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "runningdeleted",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
    });
    // The thread the turn is running on is soft-deleted before its turn ends.
    const harness = makeHarness({ initialThread: thread({ deleted: true }) });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    // Terminal now, not held `running` for the expiry backstop.
    assert.equal(status.failures.targetThreadDeleted, 1);
    assert.equal(status.runningPending, 0);
    assert.equal(status.completed, 0);
    assert.equal(status.turnFailures, 0);
    assert.equal(yield* stateOf(delegation), "failed");
    // A refusal, not a turn result: no result is returned and no turn is started.
    assert.equal(status.resultsReturned, 0);
    assert.equal(turnStarts(harness.commands).length, 0);
  }).pipe(Effect.provide(testLayer("delegation-executor-running-deleted"))),
);

// ===============================
// Token/cost budget accounting (real per-turn usage from the projection)
// ===============================

/** Cumulative usage totals recorded on a delegation row. */
const accountingOf = Effect.fn("test.accountingOf")(function* (delegation: WorkjetDelegation) {
  const store = yield* WorkjetMailboxStore;
  const accounting = yield* store.getDelegationAccounting(delegation.delegationId);
  return Option.getOrThrow(accounting);
});

it("reads one turn's tokens as a delta against the snapshot preceding it", () => {
  const base = thread();
  const withActivities = (activities: ReadonlyArray<unknown>): OrchestrationThread =>
    ({ ...base, activities }) as unknown as OrchestrationThread;

  // A thread that already ran an earlier turn must not charge ours for it.
  assert.equal(
    turnTokenUsage(
      withActivities([
        usageActivity({ index: 0, turnId: "turn-earlier", tokens: 1_000 }),
        usageActivity({ index: 1, turnId: "turn-ours", tokens: 4_000 }),
        usageActivity({ index: 2, turnId: "turn-ours", tokens: 9_000 }),
      ]),
      "turn-ours",
    ),
    8_000,
  );
  // No snapshot for our turn at all: nothing to charge, and nothing to block.
  assert.equal(
    turnTokenUsage(
      withActivities([usageActivity({ index: 0, turnId: "turn-earlier", tokens: 1_000 })]),
      "turn-ours",
    ),
    0,
  );
  assert.equal(turnTokenUsage(base, "turn-ours"), 0);
  // Fallback order: input+output when no cumulative total is reported, then
  // the context-window occupancy.
  assert.equal(
    turnTokenUsage(
      withActivities([
        {
          kind: "context-window.updated",
          turnId: "turn-ours",
          payload: { inputTokens: 30, outputTokens: 12 },
        },
      ]),
      "turn-ours",
    ),
    42,
  );
  assert.equal(
    turnTokenUsage(
      withActivities([
        { kind: "context-window.updated", turnId: "turn-ours", payload: { usedTokens: 7 } },
        { kind: "tool.completed", turnId: "turn-ours", payload: { usedTokens: 999 } },
      ]),
      "turn-ours",
    ),
    7,
  );
});

it.effect("records the dispatched turn's real token usage when the delegation completes", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "usage",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
      maxTokens: 100_000,
    });
    const harness = makeHarness({
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-usage",
        turnState: "completed",
        activities: [
          usageActivity({ index: 0, turnId: "turn-earlier", tokens: 1_000 }),
          usageActivity({ index: 1, turnId: "turn-usage", tokens: 4_000 }),
          usageActivity({ index: 2, turnId: "turn-usage", tokens: 9_000 }),
        ],
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    assert.equal(status.completed, 1);
    assert.equal(status.usageRecorded, 1);
    // Our turn's own consumption, not the thread's session total.
    assert.equal(status.usageTokensRecorded, 8_000);
    assert.equal(status.failures.tokenBudgetExceeded, 0);
    assert.equal((yield* accountingOf(delegation)).tokens, 8_000);
    // No per-turn cost figure is projected anywhere the executor can reach.
    assert.equal((yield* accountingOf(delegation)).costMicros, 0);
    assert.equal(yield* stateOf(delegation), "completed");
  }).pipe(Effect.provide(testLayer("delegation-executor-usage-recorded"))),
);

it.effect("records usage without gating when the delegation carries no ceilings", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "unlimited",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
    });
    const harness = makeHarness({
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-unlimited",
        turnState: "completed",
        activities: [usageActivity({ index: 0, turnId: "turn-unlimited", tokens: 5_000_000 })],
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    assert.isUndefined(delegation.budget.maxTokens);
    assert.equal(status.completed, 1);
    assert.equal(status.usageTokensRecorded, 5_000_000);
    assert.equal(status.failures.tokenBudgetExceeded, 0);
    assert.equal((yield* accountingOf(delegation)).tokens, 5_000_000);
    assert.equal(yield* stateOf(delegation), "completed");
  }).pipe(Effect.provide(testLayer("delegation-executor-usage-unlimited"))),
);

it.effect("charges a still-running turn once and does not double-count at completion", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "nodouble",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
      maxTokens: 100_000,
    });
    const activities = [usageActivity({ index: 0, turnId: "turn-nodouble", tokens: 8_000 })];
    const harness = makeHarness({
      initialThread: runningTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-nodouble",
        activities,
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    // Cycle 1: the turn is still running, so the usage is charged mid-run and
    // the delegation stays `running`.
    const midRun = yield* executor.runCycle;
    assert.equal(midRun.runningPending, 1);
    assert.equal(midRun.usageRecorded, 1);
    assert.equal(midRun.usageTokensRecorded, 8_000);
    assert.equal((yield* accountingOf(delegation)).tokens, 8_000);
    assert.equal(yield* stateOf(delegation), "running");

    // Cycle 2: the SAME turn, now ended, with the SAME usage snapshots. The
    // charge is a delta against what is already recorded, so nothing is added.
    harness.setThread(
      endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-nodouble",
        turnState: "completed",
        activities,
      }),
    );
    const finished = yield* executor.runCycle;
    assert.equal(finished.completed, 1);
    assert.equal(finished.usageRecorded, 1);
    assert.equal(finished.usageTokensRecorded, 8_000);
    assert.equal((yield* accountingOf(delegation)).tokens, 8_000);
    assert.equal(yield* stateOf(delegation), "completed");
  }).pipe(Effect.provide(testLayer("delegation-executor-usage-no-double"))),
);

it.effect("interrupts and fails a still-running turn that crosses its token ceiling", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "tokenceiling",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
      maxTokens: 5_000,
    });
    const harness = makeHarness({
      initialThread: runningTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-ceiling",
        activities: [usageActivity({ index: 0, turnId: "turn-ceiling", tokens: 9_000 })],
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    assert.equal(status.failures.tokenBudgetExceeded, 1);
    assert.equal(status.budgetInterrupts, 1);
    assert.equal(status.completed, 0);
    assert.equal(status.runningPending, 0);
    assert.equal(yield* stateOf(delegation), "failed");
    // The refusal happens BEFORE the durable write, so the recorded total never
    // crosses the ceiling.
    assert.equal((yield* accountingOf(delegation)).tokens, 0);

    // The live turn is asked to stop, with the derived command id.
    const interrupts = harness.commands.filter(
      (command) => command.type === "thread.turn.interrupt",
    );
    assert.equal(interrupts.length, 1);
    const interrupt = interrupts[0];
    if (interrupt === undefined || interrupt.type !== "thread.turn.interrupt") return;
    assert.equal(interrupt.commandId, delegationTurnInterruptCommandId(delegation.delegationId));
    assert.equal(interrupt.turnId, "turn-ceiling");
    assert.equal(interrupt.threadId, TARGET_THREAD);

    // A bounded failed result is persisted and reported to the source.
    const store = yield* WorkjetMailboxStore;
    const stored = yield* store.getDelegationResult(delegation.delegationId);
    assert.isTrue(Option.isSome(stored));
    if (Option.isNone(stored)) return;
    assert.equal(stored.value.outcome, "failed");
    assert.equal(stored.value.summary, "Delegation stopped: token budget exhausted.");
    assert.equal(status.resultsReturned, 1);

    // The audit contract's `budget-exceeded` event finally has a live emit site.
    const breach = harness.events.filter((event) => event._tag === "budget-exceeded");
    assert.equal(breach.length, 1);
    const event = breach[0];
    if (event === undefined || event._tag !== "budget-exceeded") return;
    assert.equal(event.kind, "tokens");
    assert.equal(event.delegationId, delegation.delegationId);
  }).pipe(Effect.provide(testLayer("delegation-executor-token-ceiling"))),
);

it.effect("fails a ceiling breach observed only at turn end without an interrupt", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "endceiling",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
      maxTokens: 5_000,
    });
    const harness = makeHarness({
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-endceiling",
        turnState: "completed",
        activities: [usageActivity({ index: 0, turnId: "turn-endceiling", tokens: 9_000 })],
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    assert.equal(status.failures.tokenBudgetExceeded, 1);
    // Nothing to interrupt: the turn is already over.
    assert.equal(status.budgetInterrupts, 0);
    assert.equal(
      harness.commands.filter((command) => command.type === "thread.turn.interrupt").length,
      0,
    );
    // The ceiling wins over the turn's own successful outcome.
    assert.equal(status.completed, 0);
    assert.equal(yield* stateOf(delegation), "failed");
  }).pipe(Effect.provide(testLayer("delegation-executor-end-ceiling"))),
);

it.effect("fails a delegation whose charge is refused by the cost ceiling", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "costceiling",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
      maxCostMicros: 1_000,
    });
    // The executor always charges zero cost (no per-turn cost figure is
    // projected), so the store's cost refusal is injected to exercise the
    // branch that handles it.
    const harness = makeHarness({
      refuseUsageCharge: "cost-budget-exceeded",
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-cost",
        turnState: "completed",
        activities: [usageActivity({ index: 0, turnId: "turn-cost", tokens: 9_000 })],
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const status = yield* executor.runCycle;

    assert.equal(status.failures.costBudgetExceeded, 1);
    assert.equal(status.failures.tokenBudgetExceeded, 0);
    assert.equal(status.usageRecorded, 0);
    assert.equal(yield* stateOf(delegation), "failed");

    const store = yield* WorkjetMailboxStore;
    const stored = yield* store.getDelegationResult(delegation.delegationId);
    assert.isTrue(Option.isSome(stored));
    if (Option.isNone(stored)) return;
    assert.equal(stored.value.summary, "Delegation stopped: cost budget exhausted.");

    const breach = harness.events.filter((event) => event._tag === "budget-exceeded");
    assert.equal(breach.length, 1);
    const event = breach[0];
    if (event === undefined || event._tag !== "budget-exceeded") return;
    assert.equal(event.kind, "cost");
  }).pipe(Effect.provide(testLayer("delegation-executor-cost-ceiling"))),
);

// ===============================
// Target version skew (undecodable row is a bounded skip, not a scan abort)
// ===============================

it.effect("skips a version-skewed delegation row while still running its readable neighbour", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const sql = yield* SqlClient.SqlClient;
    const digest = yield* storePrompt(PROMPT_TEXT);

    // A readable delivered delegation that must still run, and a second delivered
    // row rewritten to a shape this server cannot decode.
    const readable = yield* seed(
      delegationFixture({ id: "readable", digest, state: "delivered", stateChangedAt: NOW }),
    );
    const skewed = yield* seed(
      delegationFixture({ id: "skewed", digest, state: "delivered", stateChangedAt: LATER }),
    );
    yield* sql`
      UPDATE workjet_delegations
      SET delegation_json = '{"schemaVersion":999}'
      WHERE delegation_id = ${skewed.delegationId}
    `;

    const status = yield* executor.runCycle;

    // The corrupt row is counted and skipped; the cycle does not abort, and the
    // readable row runs.
    assert.equal(status.versionUnsupported, 1);
    assert.equal(status.executed, 1);
    assert.equal(status.scanned, 2);
    assert.equal(yield* stateOf(readable), "running");
    // The undecodable row is NOT dropped: it stays exactly as it was.
    const stillSkewed = yield* sql<{ readonly state: string }>`
      SELECT state AS "state" FROM workjet_delegations WHERE delegation_id = ${skewed.delegationId}
    `;
    assert.equal(stillSkewed[0]?.state, "delivered");
  }).pipe(Effect.provide(testLayer("delegation-executor-skew"))),
);

// ===============================
// Delivery dead-letter reconciliation (queued source row → failed)
// ===============================

it.effect("fails a source delegation whose outbound envelope dead-lettered", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const store = yield* WorkjetMailboxStore;
    const digest = yield* storePrompt(PROMPT_TEXT);

    // A cross-environment delegation we could never deliver: it sits `queued`
    // locally with its outbound envelope in the outbox.
    const delegation = yield* seed(
      delegationFixture({
        id: "deadletter",
        digest,
        state: "queued",
        targetEnvironmentId: REMOTE_ENVIRONMENT,
      }),
    );
    const envelope: WorkjetRoutingEnvelope = {
      schemaVersion: 1,
      envelopeId: delegation.envelopeId,
      kind: "delegation",
      sourceWorkspaceId: WORKSPACE,
      sourceEnvironmentId: LOCAL_ENVIRONMENT,
      targetWorkspaceId: WORKSPACE,
      targetEnvironmentId: REMOTE_ENVIRONMENT,
      createdAt: NOW,
      expiresAt: EXPIRES,
      signature: "c2lnbmF0dXJlLXN0dWI",
    };
    const payload = { _tag: "delegation", delegation } as const satisfies WorkjetMailboxPayload;
    yield* store.enqueueOutbound(envelope, payload);

    // Exhaust the delivery budget so the outbound row dead-letters.
    yield* Effect.forEach(
      Array.from({ length: WORKJET_MAILBOX_MAX_DELIVERY_ATTEMPTS }),
      () => store.recordAttempt(delegation.envelopeId, NOW),
      { discard: true },
    );
    const dead = yield* store.getOutbound(delegation.envelopeId);
    assert.isTrue(Option.isSome(dead));
    if (Option.isSome(dead)) assert.equal(dead.value.state, "dead");

    const status = yield* executor.runCycle;

    // The queued source row is failed explicitly, with a bounded trace on the
    // delegator's own source thread — never left queued or silently dropped.
    assert.equal(status.failures.deliveryDeadLettered, 1);
    assert.equal(yield* stateOf(delegation), "failed");
    const refused = harness.commands.find(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === WORKJET_DELEGATION_REFUSED_ACTIVITY_KIND,
    );
    assert.isDefined(refused);
    if (refused === undefined || refused.type !== "thread.activity.append") return;
    assert.equal(refused.threadId, SOURCE_THREAD);

    // Idempotent: a second cycle does not re-fail the now-terminal delegation.
    const second = yield* executor.runCycle;
    assert.equal(second.failures.deliveryDeadLettered, 1);
  }).pipe(Effect.provide(testLayer("delegation-executor-deadletter"))),
);

// ===============================
// Reassignment (delivered → different local target; never both)
// ===============================

it.effect("reassigns a delivered delegation so only the new local target runs it", () =>
  Effect.gen(function* () {
    const NEW_THREAD = ThreadId.make("thread-target-2");
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const store = yield* WorkjetMailboxStore;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(
      delegationFixture({ id: "reassign", digest, state: "delivered" }),
    );

    // A target in another environment is refused: this server cannot host it.
    const foreign = yield* executor
      .reassign({
        delegationId: delegation.delegationId,
        newTarget: address(REMOTE_ENVIRONMENT, NEW_THREAD),
      })
      .pipe(Effect.result);
    assert.equal(foreign._tag, "Failure");
    if (foreign._tag === "Failure") {
      assert.isTrue(isWorkjetMailboxError(foreign.failure));
      if (isWorkjetMailboxError(foreign.failure)) {
        assert.equal(foreign.failure.reason, "unknown-target");
      }
    }
    // Unmoved by the refused reassignment.
    const afterForeign = yield* store.getDelegation(delegation.delegationId);
    if (Option.isSome(afterForeign)) {
      assert.equal(afterForeign.value.delegation.target.threadId, TARGET_THREAD);
    }

    // Reassign to a different LOCAL thread, then run: the turn is dispatched to
    // the NEW thread, exactly once — the old target never runs it.
    const reassigned = yield* executor.reassign({
      delegationId: delegation.delegationId,
      newTarget: address(LOCAL_ENVIRONMENT, NEW_THREAD),
    });
    assert.equal(reassigned.state, "delivered");
    assert.equal(reassigned.delegation.target.threadId, NEW_THREAD);

    harness.setThread({ ...thread(), id: NEW_THREAD } as unknown as OrchestrationThread);
    const status = yield* executor.runCycle;
    assert.equal(status.executed, 1);
    assert.equal(yield* stateOf(delegation), "running");
    const starts = turnStarts(harness.commands);
    assert.equal(starts.length, 1);
    const start = starts[0];
    if (start === undefined || start.type !== "thread.turn.start") return;
    assert.equal(start.threadId, NEW_THREAD);
  }).pipe(Effect.provide(testLayer("delegation-executor-reassign"))),
);

it.effect("refuses to reassign a running delegation", () =>
  Effect.gen(function* () {
    const NEW_THREAD = ThreadId.make("thread-target-2");
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(
      delegationFixture({ id: "reassignrun", digest, state: "running" }),
    );

    const result = yield* executor
      .reassign({
        delegationId: delegation.delegationId,
        newTarget: address(LOCAL_ENVIRONMENT, NEW_THREAD),
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure" && isWorkjetMailboxError(result.failure)) {
      assert.equal(result.failure.reason, "invalid-state-transition");
    }
    // Still running, still on the original target.
    assert.equal(yield* stateOf(delegation), "running");
  }).pipe(Effect.provide(testLayer("delegation-executor-reassign-running"))),
);

// ===============================
// Redacted audit events
// ===============================

const auditTags = (events: ReadonlyArray<WorkjetMailboxAuditEventInput>) =>
  events.map((event) => event._tag);

it.effect("emits delegation-state-changed for each transition on the happy path", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(
      delegationFixture({ id: "audit-happy", digest, state: "delivered" }),
    );

    yield* executor.runCycle;

    const changes = harness.events.filter((event) => event._tag === "delegation-state-changed");
    // delivered → accepted, then accepted → running.
    assert.deepEqual(
      changes.map((event) =>
        event._tag === "delegation-state-changed" ? [event.from, event.to] : [],
      ),
      [
        ["delivered", "accepted"],
        ["accepted", "running"],
      ],
    );
    const first = changes[0];
    if (first?._tag !== "delegation-state-changed") return assert.fail("expected a change");
    assert.equal(first.delegationId, delegation.delegationId);
    // Redaction: the prompt never appears on any audit event.
    assert.notInclude(JSON.stringify(harness.events), PROMPT_TEXT);
  }).pipe(Effect.provide(testLayer("delegation-executor-audit-happy"))),
);

it.effect("emits delegation-approval-required exactly once while a gate holds", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const store = yield* WorkjetMailboxStore;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(
      delegationFixture({
        id: "audit-approval",
        digest,
        state: "delivered",
        requiresApproval: true,
      }),
    );

    // Three gated cycles must still announce the approval requirement only once.
    yield* executor.runCycle;
    yield* executor.runCycle;
    yield* executor.runCycle;

    const approvals = harness.events.filter(
      (event) => event._tag === "delegation-approval-required",
    );
    assert.equal(approvals.length, 1);
    const approval = approvals[0];
    if (approval?._tag !== "delegation-approval-required") return;
    assert.equal(approval.delegationId, delegation.delegationId);

    // Once approved, it runs and emits state changes, but never a second approval.
    yield* store.setDelegationApproval(delegation.delegationId, true, NOW);
    yield* executor.runCycle;
    assert.equal(
      harness.events.filter((event) => event._tag === "delegation-approval-required").length,
      1,
    );
    assert.include(auditTags(harness.events), "delegation-state-changed");
  }).pipe(Effect.provide(testLayer("delegation-executor-audit-approval"))),
);

it.effect("emits delegation-completed carrying only the terminal outcome", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "audit-done",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
    });
    const harness = makeHarness({
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-audit-done",
        turnState: "completed",
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    yield* executor.runCycle;

    const completed = harness.events.find((event) => event._tag === "delegation-completed");
    assert.isDefined(completed);
    if (completed?._tag !== "delegation-completed") return;
    assert.equal(completed.delegationId, delegation.delegationId);
    assert.equal(completed.outcome, "completed");
    assert.notInclude(JSON.stringify(harness.events), PROMPT_TEXT);
  }).pipe(Effect.provide(testLayer("delegation-executor-audit-completed"))),
);

it.effect("keeps a transition durable when the audit emitter throws (best-effort)", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ failAudit: true });
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(
      delegationFixture({ id: "audit-boom", digest, state: "delivered" }),
    );

    // An exploding emitter must not fail the cycle: the delegation still runs.
    const status = yield* executor.runCycle;
    assert.equal(status.executed, 1);
    assert.equal(yield* stateOf(delegation), "running");
    assert.isTrue(harness.events.length >= 1);
  }).pipe(Effect.provide(testLayer("delegation-executor-audit-besteffort"))),
);

// ===============================
// Cross-environment result REDELIVERY (migration 049 markers)
// ===============================

/** A cross-environment delegation whose dispatched turn has just completed. */
const crossEnvironmentHarness = Effect.fn("test.crossEnvironmentHarness")(function* (id: string) {
  const delegation = delegationFixture({
    id,
    digest: yield* storePrompt(PROMPT_TEXT),
    state: "running",
    sourceEnvironmentId: REMOTE_ENVIRONMENT,
  });
  return {
    delegation,
    harness: makeHarness({
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: `turn-${id}`,
        turnState: "completed",
      }),
    }),
  };
});

it.effect("retries a transiently failed result enqueue on the next cycle, exactly once", () =>
  Effect.gen(function* () {
    const { delegation, harness } = yield* crossEnvironmentHarness("redeliver");
    const executor = yield* harness.executor;
    const store = yield* WorkjetMailboxStore;
    yield* seed(delegation);
    harness.failNextEnqueues(1, "transient");

    // Cycle 1: the delegation is finalized and its result persisted, but the
    // enqueue fails transiently — the old behaviour lost the return here.
    const first = yield* executor.runCycle;
    assert.equal(first.completed, 1);
    assert.equal(first.resultsEnqueued, 0);
    assert.equal(first.resultRedeliveries, 0);
    assert.equal(first.resultReturnsAbandoned, 0);
    assert.equal(harness.enqueueAttempts(), 1);
    assert.isTrue(
      Option.isNone(yield* store.getOutbound(delegationResultEnvelopeId(delegation.delegationId))),
    );

    // Cycle 2: the durable marker is still unset, so the redelivery scan finds
    // the row and re-enqueues the SAME derived envelope.
    const second = yield* executor.runCycle;
    assert.equal(second.resultRedeliveries, 1);
    assert.equal(second.resultsEnqueued, 1);
    assert.equal(harness.enqueueAttempts(), 2);
    const outbound = yield* store.getOutbound(delegationResultEnvelopeId(delegation.delegationId));
    assert.isTrue(Option.isSome(outbound));
    if (Option.isNone(outbound)) return;
    assert.equal(outbound.value.envelope.kind, "result");
    assert.equal(outbound.value.envelope.targetEnvironmentId, REMOTE_ENVIRONMENT);

    // Cycle 3: the marker is set, so the row leaves the scan set for good.
    const third = yield* executor.runCycle;
    assert.equal(third.resultRedeliveries, 1);
    assert.equal(third.resultsEnqueued, 1);
    assert.equal(harness.enqueueAttempts(), 2);
  }).pipe(Effect.provide(testLayer("delegation-executor-redeliver"))),
);

it.effect("abandons a result enqueue that fails permanently and stops retrying", () =>
  Effect.gen(function* () {
    const { delegation, harness } = yield* crossEnvironmentHarness("redeliver-perm");
    const executor = yield* harness.executor;
    yield* seed(delegation);
    // A bounded mailbox reason: the same bytes would be rejected forever.
    harness.failNextEnqueues(5, "permanent");

    const first = yield* executor.runCycle;
    assert.equal(first.completed, 1);
    assert.equal(first.resultsEnqueued, 0);
    assert.equal(first.resultReturnsAbandoned, 1);
    assert.equal(harness.enqueueAttempts(), 1);

    // Marked: no further attempt is ever made, and the delegation stays
    // terminal with its durable result intact.
    const second = yield* executor.runCycle;
    assert.equal(second.resultReturnsAbandoned, 1);
    assert.equal(second.resultRedeliveries, 0);
    assert.equal(harness.enqueueAttempts(), 1);
    assert.equal(yield* stateOf(delegation), "completed");
    const store = yield* WorkjetMailboxStore;
    assert.isTrue(Option.isSome(yield* store.getDelegationResult(delegation.delegationId)));
  }).pipe(Effect.provide(testLayer("delegation-executor-redeliver-perm"))),
);

it.effect("never re-enqueues a result that already reached the outbox", () =>
  Effect.gen(function* () {
    const { delegation, harness } = yield* crossEnvironmentHarness("redeliver-once");
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const first = yield* executor.runCycle;
    assert.equal(first.resultsEnqueued, 1);
    assert.equal(harness.enqueueAttempts(), 1);

    const second = yield* executor.runCycle;
    assert.equal(second.resultsEnqueued, 1);
    assert.equal(second.resultRedeliveries, 0);
    assert.equal(second.resultReturnsAbandoned, 0);
    assert.equal(harness.enqueueAttempts(), 1);
  }).pipe(Effect.provide(testLayer("delegation-executor-redeliver-once"))),
);

it.effect("marks a locally returned result so the cross-environment scan skips it", () =>
  Effect.gen(function* () {
    const delegation = delegationFixture({
      id: "redeliver-local",
      digest: yield* storePrompt(PROMPT_TEXT),
      state: "running",
    });
    const harness = makeHarness({
      initialThread: endedTurnThread({
        delegationId: delegation.delegationId,
        turnId: "turn-redeliver-local",
        turnState: "completed",
      }),
    });
    const executor = yield* harness.executor;
    yield* seed(delegation);

    const first = yield* executor.runCycle;
    assert.equal(first.resultsReturned, 1);

    // A same-environment return has no outbound envelope; the marker keeps the
    // row out of the retry scan instead of enqueuing one for a local source.
    const second = yield* executor.runCycle;
    assert.equal(second.resultsEnqueued, 0);
    assert.equal(second.resultRedeliveries, 0);
    assert.equal(harness.enqueueAttempts(), 0);
  }).pipe(Effect.provide(testLayer("delegation-executor-redeliver-local"))),
);

// ===============================
// Dead-letter reconciliation marker (each dead row exactly once)
// ===============================

it.effect("reconciles each dead outbox row exactly once, legacy rows included", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const store = yield* WorkjetMailboxStore;
    const digest = yield* storePrompt(PROMPT_TEXT);

    const deadLetter = Effect.fn("test.deadLetter")(function* (id: string) {
      const delegation = yield* seed(
        delegationFixture({
          id,
          digest,
          state: "queued",
          targetEnvironmentId: REMOTE_ENVIRONMENT,
        }),
      );
      const envelope: WorkjetRoutingEnvelope = {
        schemaVersion: 1,
        envelopeId: delegation.envelopeId,
        kind: "delegation",
        sourceWorkspaceId: WORKSPACE,
        sourceEnvironmentId: LOCAL_ENVIRONMENT,
        targetWorkspaceId: WORKSPACE,
        targetEnvironmentId: REMOTE_ENVIRONMENT,
        createdAt: NOW,
        expiresAt: EXPIRES,
        signature: "c2lnbmF0dXJlLXN0dWI",
      };
      yield* store.enqueueOutbound(envelope, {
        _tag: "delegation",
        delegation,
      } as const satisfies WorkjetMailboxPayload);
      yield* Effect.forEach(
        Array.from({ length: WORKJET_MAILBOX_MAX_DELIVERY_ATTEMPTS }),
        () => store.recordAttempt(delegation.envelopeId, NOW),
        { discard: true },
      );
      return delegation;
    });

    const first = yield* deadLetter("recon-one");
    const cycleOne = yield* executor.runCycle;
    assert.equal(cycleOne.failures.deliveryDeadLettered, 1);
    assert.equal(yield* stateOf(first), "failed");

    // The dead row still exists, but is no longer in the scan set: the
    // reconciler will never read it again.
    assert.equal((yield* store.listOutboundByState("dead", 10)).length, 1);
    assert.equal((yield* store.listUnreconciledOutboundByState("dead", 10)).length, 0);

    // A row pinned before the marker existed is simply unmarked, so it still
    // reconciles on the very next cycle.
    const legacy = yield* deadLetter("recon-legacy");
    const cycleTwo = yield* executor.runCycle;
    assert.equal(cycleTwo.failures.deliveryDeadLettered, 2);
    assert.equal(yield* stateOf(legacy), "failed");
    assert.equal((yield* store.listUnreconciledOutboundByState("dead", 10)).length, 0);
  }).pipe(Effect.provide(testLayer("delegation-executor-recon-marker"))),
);

// ===============================
// The mailbox RPC's reassignment port IS the executor's
// ===============================

it.effect("satisfies the mailbox RPC's reassignment port with its own guard", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const executor = yield* harness.executor;
    const digest = yield* storePrompt(PROMPT_TEXT);
    const delegation = yield* seed(
      delegationFixture({ id: "rpc-reassign", digest, state: "delivered" }),
    );
    const reassignedThread = ThreadId.make("thread-reassigned");

    // The WebSocket route builds exactly this: the RPC handlers with the LIVE
    // executor's `reassign` as the port. No second store write, no duplicated
    // environment guard.
    const rpc = makeWorkjetMailboxRpcHandlers({
      delivery: undefined as unknown as WorkjetMailboxRpcDependencies["delivery"],
      snapshots: undefined as unknown as WorkjetMailboxRpcDependencies["snapshots"],
      query: {
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              ...thread({ role: "orchestrator" }),
              id: SOURCE_THREAD,
            } as unknown as OrchestrationThread),
          ),
      },
      workspaceId: WORKSPACE,
      environmentId: LOCAL_ENVIRONMENT,
      reassign: executor.reassign,
      nowIso: Effect.succeed("2026-08-19T12:00:00.000Z"),
      sourceRemoteConfigured: () => Effect.succeed(false),
      delegationTargetThreadId: () => Effect.succeed(Option.none()),
    });

    const result = yield* rpc.reassignDelegation({
      sourceThreadId: SOURCE_THREAD,
      delegationId: delegation.delegationId,
      targetEnvironmentId: LOCAL_ENVIRONMENT,
      targetThreadId: reassignedThread,
    });

    assert.equal(result.targetThreadId, reassignedThread);
    assert.equal(result.state, "delivered");
    // The durable row really moved, through the executor's store write.
    const stored = yield* (yield* WorkjetMailboxStore).getDelegation(delegation.delegationId);
    assert.isTrue(Option.isSome(stored));
    if (Option.isNone(stored)) return;
    assert.equal(stored.value.delegation.target.threadId, reassignedThread);

    // The executor owns the foreign-environment refusal, so calling the port
    // directly with a remote target is refused by the SAME guard.
    const refused = yield* Effect.flip(
      executor.reassign({
        delegationId: delegation.delegationId,
        newTarget: address(REMOTE_ENVIRONMENT, reassignedThread),
      }),
    );
    assert.isTrue(isWorkjetMailboxError(refused));
    if (!isWorkjetMailboxError(refused)) return;
    assert.equal(refused.reason, "unknown-target");
  }).pipe(Effect.provide(testLayer("delegation-executor-rpc-port"))),
);
