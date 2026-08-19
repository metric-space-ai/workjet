// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The reconciler that makes a DELIVERED delegation actually run
 * (docs/workjet-plan.md → Wave 5: "Deliver accepted tasks through normal T3
 * `thread.turn.start` semantics …" and the reconciler that "resumes after
 * restart, applies backpressure, orders events per delegation, and queues
 * target prompts while a thread already has an active turn").
 *
 * Until this module existed a delegation stopped at `delivered`: the durable
 * row, the inbox envelope, and the thread activity all landed, but nothing ever
 * turned the delegation into work. This service is that missing step and
 * nothing else — it does not deliver, does not transport, does not report
 * results back to the delegator.
 *
 * The loop is the queue. There is deliberately NO second queue table: a
 * delegation whose target thread is busy simply STAYS in `delivered`, and the
 * store's `stateChangedAt ASC` scan order is the per-delegation ordering the
 * plan asks for. That also makes restart resume free: whatever a previous
 * process left in `delivered` or `accepted` is exactly what the first cycle
 * after construction picks up.
 *
 * Scope of this slice — SAME-ENVIRONMENT delegations only:
 *
 * A delegation that arrived from another machine carries a prompt snapshot
 * REFERENCE whose bytes live on the SOURCE machine; cross-machine snapshot
 * transfer is a later slice. Such a row therefore resolves to "snapshot
 * missing", is COUNTED, and stays `delivered` for a later cycle. It is never
 * failed: the delegation is perfectly valid, this machine simply cannot read
 * its prompt yet, and failing it would destroy work that becomes runnable the
 * moment snapshot transfer lands.
 *
 * Retry semantics (the transition table has no `accepted → delivered` edge, so
 * a half-executed delegation can never be put back):
 *
 * - The turn-start command id is DERIVED FROM THE DELEGATION ID, so a retry is
 *   idempotent by the engine's own command receipts: a command that already
 *   succeeded returns its original sequence instead of starting a second turn.
 * - A NON-RETRYABLE engine rejection (an invariant violation, or the recorded
 *   rejection of that same command id) transitions `accepted → failed`.
 * - Anything else — a SQL failure, a projector failure — leaves the row in
 *   `accepted`, counts a retry, and the next cycle dispatches the SAME command
 *   id again.
 */
import {
  CommandId,
  EventId,
  MessageId,
  type EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ThreadId,
  type WorkjetDelegation,
  type WorkjetDelegationId,
  type WorkjetMailboxTimestamp,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkjetMailboxStore, type WorkjetDelegationRecord } from "./WorkjetMailboxStore.ts";
import { WorkjetSnapshotStore } from "./WorkjetSnapshotStore.ts";

// ===============================
// Bounds
// ===============================

/**
 * Reconciler cadence. Ten seconds is the plan's "bounded reconciler" tempo: a
 * delegation is a unit of work measured in minutes, so a faster loop would only
 * add scan cost, and a slower one would make a freshly delivered task feel
 * stuck.
 *
 * There is deliberately NO kick on local delivery in this slice. A kick would
 * have to reach from {@link WorkjetMailboxDelivery} into this service, which
 * inverts the current dependency direction (delivery knows nothing about
 * execution) and buys at most ten seconds of latency on a unit of work that
 * runs for minutes. When the latency actually matters the honest change is a
 * shared signal both services observe, not a back-reference.
 */
export const WORKJET_DELEGATION_EXECUTOR_INTERVAL = Duration.seconds(10);

/** Rows examined per state per cycle. A backlog drains over several cycles. */
export const WORKJET_DELEGATION_EXECUTOR_BATCH_SIZE = 32;

/** A wedged cycle must never take the loop or the server down. */
const WORKJET_DELEGATION_EXECUTOR_CYCLE_TIMEOUT = Duration.seconds(60);

/** Thread-visible activity kinds appended by the executor. */
export const WORKJET_DELEGATION_STARTED_ACTIVITY_KIND = "workjet.delegation.started";
export const WORKJET_DELEGATION_REFUSED_ACTIVITY_KIND = "workjet.delegation.refused";

/**
 * Thread roles a delegation may be executed INTO.
 *
 * `worker` is the obvious one. `standard` is included because a plain thread is
 * the pre-Workjet default (`DEFAULT_WORKJET_THREAD_CONFIG`) and a user pointing
 * a delegation at an ordinary thread is asking for exactly what a delegation
 * is: a task, delivered as a turn.
 *
 * `orchestrator` is REFUSED. An orchestrator's turns are the human's
 * conversation and the place worker dispatch is authorized from; letting a
 * delegation inject a turn there would let any peer drive the orchestration
 * seat itself, and `WorkerDispatch` already refuses the mirror image of this
 * (`parent-not-orchestrator`). The refusal is terminal — the role of a thread
 * is not going to change while the row waits — so it moves `delivered → failed`
 * with a bounded reason rather than looping forever.
 */
const EXECUTABLE_TARGET_ROLES = new Set(["worker", "standard"]);

// ===============================
// Status
// ===============================

/** Why a delegation was refused. Bounded labels; never prompt or path material. */
export type WorkjetDelegationRefusalReason =
  | "target-thread-missing"
  | "target-thread-deleted"
  | "target-role-not-executable"
  | "engine-rejected";

export interface WorkjetDelegationExecutorFailures {
  readonly targetThreadMissing: number;
  readonly targetThreadDeleted: number;
  readonly targetRoleNotExecutable: number;
  readonly engineRejected: number;
}

/**
 * Bounded, redaction-safe counters for later UI exposure. Counts and one
 * timestamp only: no delegation ids, no thread ids, no prompt material.
 */
export interface WorkjetDelegationExecutorStatus {
  readonly schemaVersion: 1;
  /** Completed cycles, including the ones that found nothing to do. */
  readonly cycles: number;
  /** Rows examined across both scanned states. */
  readonly scanned: number;
  /** Delegations that reached `running` with a dispatched turn. */
  readonly executed: number;
  /** Skips because the target thread already had an active turn. */
  readonly backpressure: number;
  /** Skips because the prompt snapshot is not readable on this machine. */
  readonly missingSnapshot: number;
  /** Skips because the target lives in another environment. */
  readonly foreignEnvironment: number;
  /** Skips because a projection or store read failed transiently. */
  readonly transientSkips: number;
  /** `accepted` rows whose turn start will be retried with the same command id. */
  readonly dispatchRetries: number;
  /** Delegations moved to the terminal `failed` state, by reason. */
  readonly failures: WorkjetDelegationExecutorFailures;
  readonly lastCycleAt: string | null;
}

export interface WorkjetDelegationExecutorShape {
  /** Bounded snapshot of what the loop has done since construction. */
  readonly status: Effect.Effect<WorkjetDelegationExecutorStatus>;

  /**
   * One bounded reconciliation cycle. The scheduled loop calls exactly this, so
   * a test drives the real cycle rather than a parallel test-only path.
   */
  readonly runCycle: Effect.Effect<WorkjetDelegationExecutorStatus>;
}

export class WorkjetDelegationExecutor extends Context.Service<
  WorkjetDelegationExecutor,
  WorkjetDelegationExecutorShape
>()("t3/workjet/mailbox/WorkjetDelegationExecutor") {}

export interface WorkjetDelegationExecutorSources {
  readonly nowIso: Effect.Effect<string>;
  readonly environmentId: Effect.Effect<EnvironmentId>;
}

// ===============================
// Deterministic identifiers
// ===============================

/**
 * The turn-start command id of a delegation. Derived, never random: the engine
 * deduplicates on the command id, so a retry after a transient failure or a
 * restart can never produce a second turn for the same delegation.
 */
export const delegationTurnCommandId = (delegationId: WorkjetDelegationId): CommandId =>
  CommandId.make(`server:workjet-delegation-turn:${delegationId}`);

/** Derived for the same reason: one delegation, one user message. */
export const delegationTurnMessageId = (delegationId: WorkjetDelegationId): MessageId =>
  MessageId.make(`workjet-delegation-message:${delegationId}`);

const delegationActivityCommandId = (
  delegationId: WorkjetDelegationId,
  suffix: string,
): CommandId => CommandId.make(`server:workjet-delegation-${suffix}:${delegationId}`);

const delegationActivityEventId = (delegationId: WorkjetDelegationId, suffix: string): EventId =>
  EventId.make(`workjet-delegation-${suffix}:${delegationId}`);

// ===============================
// Predicates
// ===============================

/**
 * Whether a thread is mid-turn. Both projections are consulted because they
 * become true at different moments: `latestTurn.state === "running"` covers the
 * window between the turn-start request and the provider session, and
 * `session.activeTurnId` covers a live session.
 *
 * The orchestration decider does NOT refuse a `thread.turn.start` on a busy
 * thread — it happily appends a second user message — so this check is the only
 * thing standing between a delegation and a trampled turn.
 */
export const threadHasActiveTurn = (thread: OrchestrationThread): boolean =>
  thread.latestTurn?.state === "running" || (thread.session?.activeTurnId ?? null) !== null;

/**
 * A dispatch failure this delegation can never recover from. An invariant
 * violation means the command itself is impossible against this thread, and a
 * previously-rejected receipt is the durable memory of exactly that — retrying
 * either would loop forever.
 */
const isNonRetryableDispatchError = (error: { readonly _tag: string }): boolean =>
  error._tag === "OrchestrationCommandInvariantError" ||
  error._tag === "OrchestrationCommandPreviouslyRejectedError";

// ===============================
// Service
// ===============================

/** Outcome of examining one row; drives the counters and nothing else. */
type ExecutionOutcome =
  | { readonly _tag: "executed" }
  | { readonly _tag: "backpressure"; readonly threadId: ThreadId }
  | { readonly _tag: "missing-snapshot" }
  | { readonly _tag: "foreign-environment" }
  | { readonly _tag: "transient" }
  | { readonly _tag: "retry-dispatch" }
  | { readonly _tag: "failed"; readonly reason: WorkjetDelegationRefusalReason };

export const makeWorkjetDelegationExecutorWithSources = Effect.fn(
  "WorkjetDelegationExecutor.makeWithSources",
)(function* (sources: WorkjetDelegationExecutorSources) {
  const store = yield* WorkjetMailboxStore;
  const snapshots = yield* WorkjetSnapshotStore;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;

  let cycles = 0;
  let scanned = 0;
  let executed = 0;
  let backpressure = 0;
  let missingSnapshot = 0;
  let foreignEnvironment = 0;
  let transientSkips = 0;
  let dispatchRetries = 0;
  let targetThreadMissing = 0;
  let targetThreadDeleted = 0;
  let targetRoleNotExecutable = 0;
  let engineRejected = 0;
  let lastCycleAt: string | null = null;

  const snapshot = (): WorkjetDelegationExecutorStatus => ({
    schemaVersion: 1,
    cycles,
    scanned,
    executed,
    backpressure,
    missingSnapshot,
    foreignEnvironment,
    transientSkips,
    dispatchRetries,
    failures: {
      targetThreadMissing,
      targetThreadDeleted,
      targetRoleNotExecutable,
      engineRejected,
    },
    lastCycleAt,
  });

  /**
   * Thread-visible durable trace, mirroring the delivery service's own
   * best-effort append: the mailbox store is authoritative for the delegation's
   * state, so a refused activity must never turn an executed delegation into a
   * reported failure. The command id is derived, so a retry appends once.
   */
  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly delegationId: WorkjetDelegationId;
    readonly suffix: string;
    readonly kind: string;
    readonly tone: "info" | "error";
    readonly summary: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }) =>
    Effect.suspend(() => {
      const command = {
        type: "thread.activity.append",
        commandId: delegationActivityCommandId(input.delegationId, input.suffix),
        threadId: input.threadId,
        activity: {
          id: delegationActivityEventId(input.delegationId, input.suffix),
          tone: input.tone,
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      } as const satisfies OrchestrationCommand;
      return engine.dispatch(command);
    }).pipe(Effect.ignore);

  /**
   * Bounded activity payload: ids and lifecycle state only — never the prompt,
   * never the snapshot reference, never the scope prose.
   */
  const activityPayload = (input: {
    readonly delegation: WorkjetDelegation;
    readonly state: string;
    readonly reason?: WorkjetDelegationRefusalReason;
  }) => ({
    schemaVersion: 1 as const,
    delegationId: input.delegation.delegationId,
    envelopeId: input.delegation.envelopeId,
    source: {
      workspaceId: input.delegation.source.workspaceId,
      environmentId: input.delegation.source.environmentId,
      threadId: input.delegation.source.threadId,
    },
    target: {
      workspaceId: input.delegation.target.workspaceId,
      environmentId: input.delegation.target.environmentId,
      threadId: input.delegation.target.threadId,
    },
    delegationState: input.state,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });

  const transition = (
    record: WorkjetDelegationRecord,
    to: "accepted" | "running" | "failed",
    now: string,
  ) =>
    store
      .transitionDelegationState(
        record.delegationId,
        record.state,
        to,
        now as WorkjetMailboxTimestamp,
      )
      .pipe(Effect.option);

  /**
   * Terminal refusal. A `delivered` or `accepted` row that can never run moves
   * straight to `failed` (the transition table's terminal escape) and leaves a
   * bounded, thread-visible trace when there is a thread to leave it on.
   */
  const refuse = (input: {
    readonly record: WorkjetDelegationRecord;
    readonly reason: WorkjetDelegationRefusalReason;
    readonly threadId: ThreadId | null;
    readonly now: string;
  }): Effect.Effect<ExecutionOutcome> =>
    Effect.gen(function* () {
      const moved = yield* transition(input.record, "failed", input.now);
      if (Option.isNone(moved)) {
        // The row moved underneath us (cancelled, expired, or already
        // terminal). That is a legitimate concurrent outcome, not a failure of
        // this cycle.
        return { _tag: "transient" } as const;
      }
      if (input.threadId !== null) {
        yield* appendActivity({
          threadId: input.threadId,
          delegationId: input.record.delegationId,
          suffix: "refused",
          kind: WORKJET_DELEGATION_REFUSED_ACTIVITY_KIND,
          tone: "error",
          summary: "Workjet delegation refused",
          payload: activityPayload({
            delegation: input.record.delegation,
            state: "failed",
            reason: input.reason,
          }),
          createdAt: input.now,
        });
      }
      yield* Effect.logInfo("Workjet delegation refused").pipe(
        Effect.annotateLogs({ reason: input.reason }),
      );
      return { _tag: "failed", reason: input.reason } as const;
    });

  /**
   * The verified prompt bytes, or `None` when this machine cannot read them.
   *
   * Resolved BEFORE a `delivered` row is accepted, so a delegation whose
   * snapshot is not here stays exactly where it was rather than being moved
   * into a state the transition table cannot walk back.
   */
  const resolvePrompt = (record: WorkjetDelegationRecord) =>
    snapshots.get(record.delegation.prompt.digest).pipe(
      Effect.option,
      // Same-environment: a genuinely damaged or absent object. Remote inbound:
      // the bytes live on the SOURCE machine and cross-machine snapshot
      // transfer is a later slice. Both are counted and retried, never failed.
      Effect.tap((prompt) =>
        Option.isNone(prompt)
          ? Effect.logDebug("Workjet delegation prompt snapshot unavailable")
          : Effect.void,
      ),
    );

  /**
   * The half that runs for a row already in `accepted`: dispatch the turn and
   * move `accepted → running`. Reached both by a fresh `delivered` row in the
   * same cycle and by a row a previous process left behind, which is exactly
   * why it is one routine.
   */
  const startTurn = (input: {
    readonly record: WorkjetDelegationRecord;
    readonly thread: OrchestrationThread;
    readonly promptText: string;
    readonly now: string;
  }): Effect.Effect<ExecutionOutcome> =>
    Effect.gen(function* () {
      const delegation = input.record.delegation;
      const command = {
        type: "thread.turn.start",
        commandId: delegationTurnCommandId(delegation.delegationId),
        threadId: input.thread.id,
        message: {
          messageId: delegationTurnMessageId(delegation.delegationId),
          role: "user",
          text: input.promptText,
          attachments: [],
        },
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        createdAt: input.now,
      } as const satisfies OrchestrationCommand;

      const dispatched = yield* Effect.result(engine.dispatch(command));
      if (dispatched._tag === "Failure") {
        if (isNonRetryableDispatchError(dispatched.failure)) {
          return yield* refuse({
            record: input.record,
            reason: "engine-rejected",
            threadId: input.thread.id,
            now: input.now,
          });
        }
        // There is no `accepted → delivered` edge, and inventing one would let
        // a half-executed delegation be re-accepted twice. The row therefore
        // STAYS in `accepted` and the next cycle dispatches the same, derived,
        // command id again — idempotent by the engine's command receipts.
        yield* Effect.logWarning("Workjet delegation turn start will be retried");
        return { _tag: "retry-dispatch" } as const;
      }

      const running = yield* transition(input.record, "running", input.now);
      if (Option.isNone(running)) {
        // The turn IS started; only the bookkeeping lost a race with a
        // cancellation or expiry. Nothing to undo and nothing to retry.
        return { _tag: "transient" } as const;
      }

      yield* appendActivity({
        threadId: input.thread.id,
        delegationId: delegation.delegationId,
        suffix: "started",
        kind: WORKJET_DELEGATION_STARTED_ACTIVITY_KIND,
        tone: "info",
        summary: "Workjet delegation started",
        payload: activityPayload({ delegation, state: "running" }),
        createdAt: input.now,
      });
      return { _tag: "executed" } as const;
    });

  /**
   * Everything a row must satisfy before it may be accepted: local target,
   * existing undeleted thread, executable role, and an idle thread.
   */
  const resolveTarget = (input: {
    readonly record: WorkjetDelegationRecord;
    readonly environmentId: EnvironmentId;
    readonly busyThreads: ReadonlySet<string>;
    readonly now: string;
  }): Effect.Effect<
    { readonly _tag: "ready"; readonly thread: OrchestrationThread } | ExecutionOutcome
  > =>
    Effect.gen(function* () {
      const delegation = input.record.delegation;
      if (delegation.target.environmentId !== input.environmentId) {
        // Another machine owns this thread. Executing it here is not merely
        // wrong, it is impossible: the thread does not exist in this
        // projection. The row waits for the machine that owns it.
        return { _tag: "foreign-environment" } as const;
      }

      const threadOption = yield* query
        .getThreadDetailById(delegation.target.threadId)
        .pipe(Effect.option);
      if (Option.isNone(threadOption)) {
        // The READ failed, not the thread. A projection hiccup must never
        // consume a delegation.
        return { _tag: "transient" } as const;
      }
      const thread = Option.getOrUndefined(threadOption.value);
      if (thread === undefined) {
        return yield* refuse({
          record: input.record,
          reason: "target-thread-missing",
          threadId: null,
          now: input.now,
        });
      }
      if (thread.deletedAt !== null) {
        return yield* refuse({
          record: input.record,
          reason: "target-thread-deleted",
          threadId: null,
          now: input.now,
        });
      }
      if (!EXECUTABLE_TARGET_ROLES.has(thread.workjetConfig.role)) {
        return yield* refuse({
          record: input.record,
          reason: "target-role-not-executable",
          threadId: thread.id,
          now: input.now,
        });
      }
      if (input.busyThreads.has(thread.id) || threadHasActiveTurn(thread)) {
        // THIS is the queue. The row stays `delivered`, and the scan order
        // (`stateChangedAt ASC`) replays it before any later delegation for the
        // same thread.
        return { _tag: "backpressure", threadId: thread.id } as const;
      }
      return { _tag: "ready", thread } as const;
    });

  const runCycle = Effect.fn("WorkjetDelegationExecutor.runCycle")(function* () {
    const environmentId = yield* sources.environmentId;
    const now = yield* sources.nowIso;

    /**
     * Threads this cycle has already dispatched into. The projection is
     * eventually consistent, so a second delegation for the same thread within
     * one cycle must be held back by THIS set rather than by a read that has
     * not caught up yet.
     */
    const busyThreads = new Set<string>();

    const record = (outcome: ExecutionOutcome): void => {
      switch (outcome._tag) {
        case "executed":
          executed += 1;
          break;
        case "backpressure":
          backpressure += 1;
          break;
        case "missing-snapshot":
          missingSnapshot += 1;
          break;
        case "foreign-environment":
          foreignEnvironment += 1;
          break;
        case "transient":
          transientSkips += 1;
          break;
        case "retry-dispatch":
          dispatchRetries += 1;
          break;
        case "failed":
          switch (outcome.reason) {
            case "target-thread-missing":
              targetThreadMissing += 1;
              break;
            case "target-thread-deleted":
              targetThreadDeleted += 1;
              break;
            case "target-role-not-executable":
              targetRoleNotExecutable += 1;
              break;
            case "engine-rejected":
              engineRejected += 1;
              break;
          }
          break;
      }
    };

    const scan = (state: "accepted" | "delivered") =>
      store
        .listDelegationsByState(state, WORKJET_DELEGATION_EXECUTOR_BATCH_SIZE)
        .pipe(
          Effect.option,
          Effect.map(Option.getOrElse(() => [] as ReadonlyArray<WorkjetDelegationRecord>)),
        );

    /**
     * `accepted` FIRST. Those rows are the ones a previous process (or a
     * previous cycle) already committed to running; finishing them before
     * accepting anything new keeps a restart from piling new work on top of
     * half-started work, and marks their threads busy for the rest of the
     * cycle.
     */
    for (const row of yield* scan("accepted")) {
      scanned += 1;
      if (row.terminal) continue;
      const resolved = yield* resolveTarget({ record: row, environmentId, busyThreads, now });
      if (resolved._tag !== "ready") {
        // A busy thread here means the retried turn is already live; the row
        // stays `accepted` and the next cycle re-checks it.
        record(resolved._tag === "backpressure" ? { _tag: "retry-dispatch" } : resolved);
        if (resolved._tag === "backpressure") busyThreads.add(resolved.threadId);
        continue;
      }
      const prompt = yield* resolvePrompt(row);
      if (Option.isNone(prompt)) {
        record({ _tag: "missing-snapshot" });
        continue;
      }
      busyThreads.add(resolved.thread.id);
      record(
        yield* startTurn({
          record: row,
          thread: resolved.thread,
          promptText: prompt.value,
          now,
        }),
      );
    }

    for (const row of yield* scan("delivered")) {
      scanned += 1;
      if (row.terminal) continue;
      const resolved = yield* resolveTarget({ record: row, environmentId, busyThreads, now });
      if (resolved._tag !== "ready") {
        record(resolved);
        continue;
      }

      // Resolved BEFORE the transition: a delegation this machine cannot read
      // the prompt for must stay `delivered`, because the table has no way back
      // out of `accepted`.
      const prompt = yield* resolvePrompt(row);
      if (Option.isNone(prompt)) {
        record({ _tag: "missing-snapshot" });
        continue;
      }

      // Transactional and TOCTOU-guarded by the store: a concurrent
      // cancellation between the scan and here loses the transition, not the
      // invariant.
      const accepted = yield* transition(row, "accepted", now);
      if (Option.isNone(accepted)) {
        record({ _tag: "transient" });
        continue;
      }
      busyThreads.add(resolved.thread.id);
      record(
        yield* startTurn({
          record: accepted.value,
          thread: resolved.thread,
          promptText: prompt.value,
          now,
        }),
      );
    }

    cycles += 1;
    lastCycleAt = now;
    return snapshot();
  });

  return WorkjetDelegationExecutor.of({
    status: Effect.sync(snapshot),
    runCycle: runCycle().pipe(
      Effect.timeoutOrElse({
        duration: WORKJET_DELEGATION_EXECUTOR_CYCLE_TIMEOUT,
        orElse: () => Effect.sync(snapshot),
      }),
      Effect.catchCause(() => Effect.sync(snapshot)),
    ),
  });
});

export const makeWorkjetDelegationExecutor = Effect.fn("WorkjetDelegationExecutor.make")(
  function* () {
    const environment = yield* ServerEnvironment;
    return yield* makeWorkjetDelegationExecutorWithSources({
      nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      environmentId: environment.getEnvironmentId,
    });
  },
);

/**
 * The service plus its reconciler loop. The loop is forked into the layer's
 * scope, so it stops exactly when the server's runtime does, and its FIRST
 * cycle is the restart resume: it observes whatever `delivered` and `accepted`
 * rows the previous process left behind.
 */
export const layer = Layer.effect(
  WorkjetDelegationExecutor,
  Effect.gen(function* () {
    const executor = yield* makeWorkjetDelegationExecutor();
    yield* executor.runCycle.pipe(
      Effect.repeat(Schedule.spaced(WORKJET_DELEGATION_EXECUTOR_INTERVAL)),
      Effect.forkScoped,
    );
    return executor;
  }),
);
