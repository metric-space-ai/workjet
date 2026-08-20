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
  TurnId,
  WorkjetEnvelopeId,
  WorkjetMailboxError,
  type EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ThreadId,
  type WorkjetMailboxBudgetKind,
  type WorkjetDelegation,
  type WorkjetDelegationId,
  type WorkjetDelegationResult,
  type WorkjetMailboxPayload,
  type WorkjetMailboxTimestamp,
  type WorkjetWorkerAddress,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WorkjetMailboxAuditEmitter,
  emitAudit,
  type WorkjetMailboxAuditSink,
} from "./WorkjetMailboxAuditEmitter.ts";
import {
  isWorkjetMailboxError,
  WorkjetMailboxStore,
  type WorkjetDelegationRecord,
  type WorkjetDelegationResultReturnRow,
  type WorkjetDelegationRowResult,
  type WorkjetMailboxStoreError,
  type WorkjetOutboxRecord,
} from "./WorkjetMailboxStore.ts";
import { WorkjetMeshIdentity, type WorkjetUnsignedRoutingEnvelope } from "./WorkjetMeshIdentity.ts";
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
 * Appended to the SOURCE thread when a delegation's result returns to it.
 *
 * Deliberately an UNREGISTERED kind, exactly like `started`/`refused` above: the
 * four mailbox kinds in {@link WORKJET_MAILBOX_ACTIVITY_KINDS} are the ones the
 * timeline card decodes through `WorkjetMailboxActivityPayload`, but the
 * executor's lifecycle traces carry a different bounded payload and flow through
 * the generic activity channel. Registering a literal would only be required if
 * the client card had to decode this shape — it does not — so no contract change
 * is made for it.
 */
export const WORKJET_DELEGATION_RESULT_ACTIVITY_KIND = "workjet.delegation.result";

/**
 * Time-to-live of a result envelope enqueued back to a cross-environment source.
 * The maximum the mailbox allows (7 days): a result must outlive a transport
 * that may be offline for a long while, and the row is dropped by the expiry
 * sweep if it truly never leaves.
 */
const WORKJET_DELEGATION_RESULT_TTL_SECONDS = 604_800;

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
  /**
   * The target thread holds a capability its delegation's PARENT does not.
   * Terminal, like the role refusal beside it: a thread's grants are not going
   * to narrow while the row waits, and running it anyway would let a delegation
   * chain acquire authority `WorkerDispatch` refuses to hand out at creation.
   */
  | "target-capability-escalation"
  | "engine-rejected"
  /**
   * The delegation's outbound envelope exhausted every delivery attempt and
   * dead-lettered: the target environment was never reachable. Its source-side
   * delegation row is failed terminally rather than left `queued` forever.
   */
  | "delivery-dead-lettered"
  /**
   * The delegation's turn consumed more tokens than its `maxTokens` ceiling
   * allows. The store refused the charge BEFORE writing it, so the recorded
   * total never crosses the ceiling; the delegation is failed instead.
   */
  | "token-budget-exceeded"
  /** The same, for the `maxCostMicros` ceiling. */
  | "cost-budget-exceeded";

export interface WorkjetDelegationExecutorFailures {
  readonly targetThreadMissing: number;
  readonly targetThreadDeleted: number;
  readonly targetRoleNotExecutable: number;
  /** Delegations refused because the target outranked its parent's grants. */
  readonly targetCapabilityEscalation: number;
  readonly engineRejected: number;
  /** Delegations failed because their outbound delivery dead-lettered. */
  readonly deliveryDeadLettered: number;
  /** Delegations failed because a token ceiling refused their usage charge. */
  readonly tokenBudgetExceeded: number;
  /** Delegations failed because a cost ceiling refused their usage charge. */
  readonly costBudgetExceeded: number;
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
  /**
   * Rows skipped because their stored delegation no longer decodes through the
   * current contract schema (target version skew). Counted, never dropped, and
   * never fatal to the cycle — the readable rows in the same batch still run.
   */
  readonly versionUnsupported: number;
  /** `accepted` rows whose turn start will be retried with the same command id. */
  readonly dispatchRetries: number;
  /** `running` delegations whose dispatched turn ended successfully → `completed`. */
  readonly completed: number;
  /** `running` delegations whose dispatched turn ended in failure → `failed`. */
  readonly turnFailures: number;
  /**
   * `running` delegations whose dispatched turn was INTERRUPTED → `failed`. A
   * subset of a turn failure, counted separately because an interruption is a
   * distinct, explicit terminal outcome (`turn-interrupted`) rather than an
   * error the target produced.
   */
  readonly turnInterrupted: number;
  /** Results delivered to a SAME-environment source as a thread activity. */
  readonly resultsReturned: number;
  /** Results enqueued as pending outbound for a CROSS-environment source. */
  readonly resultsEnqueued: number;
  /**
   * The subset of {@link resultsEnqueued} the REDELIVERY scan produced: results
   * whose first enqueue failed transiently and which a later cycle re-enqueued
   * from the durable row. Idempotent by the derived result envelope id.
   */
  readonly resultRedeliveries: number;
  /**
   * Results whose return was abandoned for a PERMANENT fault — an encode or
   * signing rejection, or a delegation body this server can no longer decode.
   * The result stays durable on the row; only the retry stops.
   */
  readonly resultReturnsAbandoned: number;
  /** `running` rows whose dispatched turn has not ended yet; left running. */
  readonly runningPending: number;
  /** `delivered` rows held back because their approval gate is still pending. */
  readonly awaitingApproval: number;
  /** Accepted usage charges written against a delegation's running totals. */
  readonly usageRecorded: number;
  /** Tokens accepted by those charges. Counts only, never a delegation id. */
  readonly usageTokensRecorded: number;
  /**
   * Delegations INTERRUPTED mid-turn because a ceiling was crossed while the
   * turn was still running. A subset of the budget failures below.
   */
  readonly budgetInterrupts: number;
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

  /**
   * Reassign a still-pending delegation (`delivered`/`needs-input`) to a
   * DIFFERENT local target thread. Refuses a target in another environment
   * (`unknown-target` — this server cannot host it) and, through the store,
   * refuses any terminal or already-running delegation (`invalid-state-transition`).
   * After a successful reassignment the reconciler dispatches to the new thread
   * and only the new thread; the task is never started on both.
   */
  readonly reassign: (input: {
    readonly delegationId: WorkjetDelegationId;
    readonly newTarget: WorkjetWorkerAddress;
  }) => Effect.Effect<WorkjetDelegationRecord, WorkjetMailboxStoreError>;
}

export class WorkjetDelegationExecutor extends Context.Service<
  WorkjetDelegationExecutor,
  WorkjetDelegationExecutorShape
>()("t3/workjet/mailbox/WorkjetDelegationExecutor") {}

export interface WorkjetDelegationExecutorSources {
  readonly nowIso: Effect.Effect<string>;
  readonly environmentId: Effect.Effect<EnvironmentId>;
  /**
   * Best-effort redacted audit sink. Optional so a unit test can omit it (a
   * no-op) or inject a capturing double; the real layer wires the shared
   * {@link WorkjetMailboxAuditEmitter}.
   */
  readonly audit?: WorkjetMailboxAuditSink;
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

/**
 * The envelope id of a delegation's result. Derived from the delegation id and
 * bounded to the envelope-id length, so the same delegation always produces the
 * same result envelope id: the outbound enqueue deduplicates on it, making a
 * late or duplicate result return idempotent at the transport layer too.
 */
export const delegationResultEnvelopeId = (delegationId: WorkjetDelegationId): WorkjetEnvelopeId =>
  WorkjetEnvelopeId.make(`wjr-${delegationId}`.slice(0, 128));

/**
 * The id of the turn THIS executor dispatched for a delegation, read back from
 * the target thread's projection: the user message the executor wrote carries a
 * derived id, and its `turnId` is the only turn a completion may be attributed
 * to. Returns `null` when that message (or its turn) is not materialized yet, so
 * a delegation is NEVER completed on the strength of some other turn ending.
 */
export const dispatchedTurnId = (
  thread: OrchestrationThread,
  delegationId: WorkjetDelegationId,
): string | null => {
  const messageId = delegationTurnMessageId(delegationId);
  const message = thread.messages?.find((candidate) => candidate.id === messageId);
  return message?.turnId ?? null;
};

/**
 * The interrupt-command id of a delegation whose budget ran out mid-turn.
 * Derived like every other command this service issues, so a breach observed on
 * several consecutive cycles asks the engine to interrupt ONCE.
 */
export const delegationTurnInterruptCommandId = (delegationId: WorkjetDelegationId): CommandId =>
  CommandId.make(`server:workjet-delegation-interrupt:${delegationId}`);

/**
 * The thread-activity kind the provider-runtime ingestion appends for every
 * `thread.token-usage.updated` runtime event
 * ({@link ProviderRuntimeIngestion}). Its payload is a
 * `ThreadTokenUsageSnapshot` and it carries the `turnId` it was observed
 * during — which makes the thread-detail activity stream the ONLY per-turn
 * token source reachable from this reconciler. `projection_turns` has no usage
 * columns, and the `UsageSummary` pipeline reads provider transcripts off disk
 * on a (day, provider, model) grain that cannot be attributed to one turn.
 */
export const WORKJET_CONTEXT_WINDOW_ACTIVITY_KIND = "context-window.updated";

/** A non-negative integer field of a token-usage snapshot payload, or null. */
const usageField = (payload: Record<string, unknown>, key: string): number | null => {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
};

/**
 * The CUMULATIVE token count a usage snapshot reports, in the provider's own
 * terms:
 *
 * - `totalProcessedTokens` is the honest running total of everything the
 *   session pushed through the model, and is what both adapters set when the
 *   figure exceeds the live context occupancy.
 * - `inputTokens + outputTokens` is the fallback: the last iteration's request,
 *   which for a single-iteration turn IS the turn.
 * - `usedTokens` (context-window occupancy) is the last resort, present on
 *   every snapshot by contract.
 *
 * One extractor is used for both the baseline and the latest snapshot so the
 * subtraction below never mixes two different meanings of "tokens".
 */
const snapshotCumulativeTokens = (payload: unknown): number | null => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const snapshot = payload as Record<string, unknown>;
  const total = usageField(snapshot, "totalProcessedTokens");
  if (total !== null) return total;
  const input = usageField(snapshot, "inputTokens");
  const output = usageField(snapshot, "outputTokens");
  if (input !== null || output !== null) return (input ?? 0) + (output ?? 0);
  return usageField(snapshot, "usedTokens");
};

/**
 * Tokens attributable to ONE turn of a thread, read from the thread detail's
 * activity stream.
 *
 * The snapshots are cumulative for the whole provider SESSION, not per turn, so
 * a thread that already ran turns before the delegation's would otherwise
 * charge the delegation for its neighbours' work. The value is therefore the
 * DELTA between the last snapshot observed during our turn and the last
 * snapshot observed before our turn's first one. Activities arrive in the
 * projection's creation order (`idx_projection_thread_activities_thread_created`),
 * which is the order this scan relies on.
 *
 * Returns 0 when the turn produced no usage snapshot at all — a turn that never
 * reached the provider must not be charged, and must not be *blocked* either.
 */
export const turnTokenUsage = (thread: OrchestrationThread, turnId: string): number => {
  let baseline: number | null = null;
  let latest: number | null = null;
  let enteredTurn = false;
  for (const activity of thread.activities ?? []) {
    if (activity.kind !== WORKJET_CONTEXT_WINDOW_ACTIVITY_KIND) continue;
    const value = snapshotCumulativeTokens(activity.payload);
    if (value === null) continue;
    if (activity.turnId === turnId) {
      enteredTurn = true;
      latest = value;
    } else if (!enteredTurn) {
      baseline = value;
    }
  }
  if (latest === null) return 0;
  return Math.max(0, latest - (baseline ?? 0));
};

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
  | { readonly _tag: "version-unsupported" }
  | { readonly _tag: "retry-dispatch" }
  | { readonly _tag: "completed" }
  | { readonly _tag: "turn-failed" }
  | { readonly _tag: "turn-interrupted" }
  | { readonly _tag: "running-pending" }
  | { readonly _tag: "awaiting-approval" }
  | { readonly _tag: "failed"; readonly reason: WorkjetDelegationRefusalReason };

export const makeWorkjetDelegationExecutorWithSources = Effect.fn(
  "WorkjetDelegationExecutor.makeWithSources",
)(function* (sources: WorkjetDelegationExecutorSources) {
  const store = yield* WorkjetMailboxStore;
  const snapshots = yield* WorkjetSnapshotStore;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const identity = yield* WorkjetMeshIdentity;

  let cycles = 0;
  let scanned = 0;
  let executed = 0;
  let backpressure = 0;
  let missingSnapshot = 0;
  let foreignEnvironment = 0;
  let transientSkips = 0;
  let versionUnsupported = 0;
  let dispatchRetries = 0;
  let completed = 0;
  let turnFailures = 0;
  let turnInterrupted = 0;
  let resultsReturned = 0;
  let resultsEnqueued = 0;
  let resultRedeliveries = 0;
  let resultReturnsAbandoned = 0;
  let runningPending = 0;
  let awaitingApproval = 0;
  let usageRecorded = 0;
  let usageTokensRecorded = 0;
  let budgetInterrupts = 0;
  let targetThreadMissing = 0;
  let targetThreadDeleted = 0;
  let targetRoleNotExecutable = 0;
  let targetCapabilityEscalation = 0;
  let engineRejected = 0;
  let deliveryDeadLettered = 0;
  let tokenBudgetExceeded = 0;
  let costBudgetExceeded = 0;
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
    versionUnsupported,
    dispatchRetries,
    completed,
    turnFailures,
    turnInterrupted,
    resultsReturned,
    resultsEnqueued,
    resultRedeliveries,
    resultReturnsAbandoned,
    runningPending,
    awaitingApproval,
    usageRecorded,
    usageTokensRecorded,
    budgetInterrupts,
    failures: {
      targetThreadMissing,
      targetThreadDeleted,
      targetRoleNotExecutable,
      targetCapabilityEscalation,
      engineRejected,
      deliveryDeadLettered,
      tokenBudgetExceeded,
      costBudgetExceeded,
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

  /**
   * Delegations for which an `delegation-approval-required` audit event was
   * already announced. The approval gate holds a delegation in `delivered`
   * across many cycles, so without this the scan would re-announce it every
   * cycle and flood the bounded audit buffer. Capped so a long-lived server
   * cannot grow it without bound; overflow simply allows a re-announce.
   */
  const approvalAnnounced = yield* Ref.make<ReadonlySet<string>>(new Set<string>());
  const APPROVAL_ANNOUNCE_CAP = 4_096;

  /** Bounded, opaque audit address from a delegation (ids only). */
  const auditAddress = (address: WorkjetDelegation["source"]) => ({
    workspaceId: address.workspaceId,
    environmentId: address.environmentId,
    threadId: address.threadId,
  });

  /**
   * Best-effort redacted audit emission, mirroring the best-effort activity
   * append. Published AFTER the durable store write that produced the event.
   */
  const emit = (event: Parameters<typeof emitAudit>[1]) => emitAudit(sources.audit, event);

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
      .pipe(
        Effect.option,
        // Emitted only when the durable transition actually applied (Some).
        Effect.tap((moved) =>
          Option.isSome(moved)
            ? emit({
                _tag: "delegation-state-changed",
                occurredAt: now as WorkjetMailboxTimestamp,
                delegationId: record.delegationId,
                envelopeId: record.delegation.envelopeId,
                source: auditAddress(record.delegation.source),
                target: auditAddress(record.delegation.target),
                from: record.state,
                to,
              })
            : Effect.void,
        ),
      );

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
   * The grants the delegation's PARENT holds, when this machine can know them.
   *
   * "Parent" is the authority the delegation descends from, and there are two
   * shapes of it, checked in this order:
   *
   *  1. `delegation.parent` — a review/revise/follow-up chain. Its `owner` is
   *     the address authoritative for that delegation, which is the parent
   *     delegation's TARGET thread (see `buildResult`). A chain rooted on this
   *     machine is checkable even when the envelope arrived from a peer.
   *  2. `delegation.source` — the thread that delegated. Checkable whenever the
   *     delegating thread lives here, i.e. every local delegation.
   *
   * `unknowable` is the honest third answer: a remote-rooted delegation's
   * parent thread lives on another machine, and this server has no record of
   * its grants. It could not verify a claim about them either — the delegation
   * contract carries no capability field at all, so any such claim would be
   * peer-supplied text. Refusing on ignorance would break legitimate remote
   * delegation into every capability-bearing worker thread; the remote path's
   * actual protection is that a peer cannot CHOOSE the target's capabilities,
   * which are whatever the local operator already granted that thread.
   */
  const parentGrants = (input: {
    readonly delegation: WorkjetDelegation;
    readonly environmentId: EnvironmentId;
  }): Effect.Effect<
    | { readonly _tag: "grants"; readonly capabilityIds: ReadonlySet<string> }
    | { readonly _tag: "unknowable" }
    | { readonly _tag: "unreadable" }
  > =>
    Effect.gen(function* () {
      const parentRef = input.delegation.parent;
      const parentThreadId =
        parentRef !== undefined && parentRef.owner.environmentId === input.environmentId
          ? parentRef.owner.threadId
          : input.delegation.source.environmentId === input.environmentId
            ? input.delegation.source.threadId
            : null;
      if (parentThreadId === null) return { _tag: "unknowable" } as const;

      const parentOption = yield* query.getThreadDetailById(parentThreadId).pipe(Effect.option);
      // A projection hiccup is NOT evidence about grants. Retry rather than
      // decide, exactly as the target read above does.
      if (Option.isNone(parentOption)) return { _tag: "unreadable" } as const;

      const parent = Option.getOrUndefined(parentOption.value);
      // The parent thread is gone or deleted. FAIL CLOSED: with no authority on
      // record, the empty set is the only defensible superset, so a target
      // holding no capabilities still runs and one holding any is refused.
      // Running under a parent that no longer exists is what this check is for.
      if (parent === undefined || parent.deletedAt !== null) {
        return { _tag: "grants", capabilityIds: new Set<string>() } as const;
      }
      return {
        _tag: "grants",
        capabilityIds: new Set<string>(parent.workjetConfig.enabledCapabilityIds),
      } as const;
    });

  /**
   * Everything a row must satisfy before it may be accepted: local target,
   * existing undeleted thread, executable role, no capability escalation over
   * the parent, and an idle thread.
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

      // TARGET-SIDE CAPABILITY CHECK, beside the role check because they answer
      // the two halves of the same question: WorkerDispatch already refuses a
      // child whose requested capabilities exceed its parent's grants
      // (`capability-escalation`), but that check runs at thread CREATION. A
      // delegation targets a thread that already exists, so nothing re-asserted
      // the invariant at execution time — a chain could put work into a thread
      // holding a capability its parent never had.
      //
      // Defence in depth, verified as such rather than assumed: the delegation
      // contract carries no capability field, remote-created threads are always
      // built with `enabledCapabilityIds: []`
      // (`WorkjetMailboxDelivery.ts`, `WorkjetCrossModeThreads.ts`), and only an
      // orchestrator thread may create a delegation at all. So no peer and no
      // worker can currently reach a widened target. This keeps that true if
      // any of those three facts changes.
      const grants = yield* parentGrants({ delegation, environmentId: input.environmentId });
      if (grants._tag === "unreadable") return { _tag: "transient" } as const;
      if (
        grants._tag === "grants" &&
        thread.workjetConfig.enabledCapabilityIds.some(
          (capabilityId) => !grants.capabilityIds.has(capabilityId),
        )
      ) {
        return yield* refuse({
          record: input.record,
          reason: "target-capability-escalation",
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

  /**
   * The bounded result reported back to the source. Summary is a fixed bounded
   * label — never prompt, path, or output material — and artifact references are
   * left EMPTY in this slice: a {@link WorkjetGitBranchRef} requires a head
   * commit the thread detail does not cheaply expose, so populating a branch
   * would mean fabricating one. The digest of the work lives on the branch the
   * target worktree already carries; a later slice can lift it into `artifacts`.
   */
  const buildResult = (input: {
    readonly delegation: WorkjetDelegation;
    readonly outcome: "completed" | "failed";
    readonly envelopeId: WorkjetEnvelopeId;
    readonly now: string;
    /** A failed turn that ended specifically because it was interrupted. */
    readonly interrupted?: boolean;
    /** A failure caused by a budget ceiling rather than by the turn itself. */
    readonly budgetKind?: WorkjetMailboxBudgetKind;
  }): WorkjetDelegationResult => ({
    schemaVersion: 1,
    envelopeId: input.envelopeId,
    delegation: {
      schemaVersion: 1,
      delegationId: input.delegation.delegationId,
      // The target environment (this one) is authoritative for the delegation's
      // state and result — never the source or a forwarding peer.
      owner: input.delegation.target,
    },
    reportedBy: input.delegation.target,
    reportedAt: input.now as WorkjetMailboxTimestamp,
    outcome: input.outcome,
    summary:
      input.outcome === "completed"
        ? "Delegation turn completed."
        : input.budgetKind === "tokens"
          ? "Delegation stopped: token budget exhausted."
          : input.budgetKind === "cost"
            ? "Delegation stopped: cost budget exhausted."
            : input.interrupted === true
              ? "Delegation turn was interrupted."
              : "Delegation turn ended without success.",
    artifacts: { schemaVersion: 1, commitHashes: [], paths: [] },
  });

  /**
   * Bounded result-activity payload for the source timeline: the delegation
   * link, the terminal state, the bounded summary, and the (empty) artifact
   * references — never the prompt, never the target's output.
   */
  const resultActivityPayload = (input: {
    readonly delegation: WorkjetDelegation;
    readonly result: WorkjetDelegationResult;
  }) => ({
    schemaVersion: 1 as const,
    delegationId: input.delegation.delegationId,
    envelopeId: input.result.envelopeId,
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
    delegationState: input.result.outcome,
    outcome: input.result.outcome,
    summary: input.result.summary,
    artifacts: input.result.artifacts,
    reportedAt: input.result.reportedAt,
  });

  /** now + seconds, as an ISO string; a malformed now falls back to now. */
  const addSeconds = (nowIso: string, seconds: number): string =>
    Option.match(DateTime.make(nowIso), {
      onNone: () => nowIso,
      onSome: (instant) =>
        DateTime.formatIso(DateTime.addDuration(instant, Duration.seconds(seconds))),
    });

  /**
   * Outcome of returning one finalized result to its source.
   *
   * `deferred` is the only one that leaves the durable markers untouched, which
   * is precisely what puts the row back in the redelivery scan's queue.
   */
  type ResultReturnOutcome = "returned" | "deferred" | "abandoned";

  /** Stamp the durable marker; best-effort, exactly like the activity append. */
  const markResultReturned = (delegationId: WorkjetDelegationId, now: string) =>
    store
      .markDelegationResultReturned(delegationId, now as WorkjetMailboxTimestamp)
      .pipe(Effect.ignore);

  const markResultReturnAbandoned = (delegationId: WorkjetDelegationId, now: string) =>
    store
      .markDelegationResultReturnFailed(delegationId, now as WorkjetMailboxTimestamp)
      .pipe(Effect.ignore);

  /**
   * Enqueue a signed `result` envelope as pending outbound for a
   * CROSS-environment source. The transport slice carries it; nothing here
   * reaches another machine. The envelope id is derived from the delegation id,
   * so the outbox deduplicates a repeated attempt into the same row — which is
   * what makes the redelivery scan below safe to retry blindly.
   */
  const enqueueCrossEnvironmentResult = (input: {
    readonly delegation: WorkjetDelegation;
    readonly result: WorkjetDelegationResult;
    readonly environmentId: EnvironmentId;
    readonly now: string;
  }): Effect.Effect<ResultReturnOutcome> =>
    Effect.gen(function* () {
      const source = input.delegation.source;
      const createdAt = input.now as WorkjetMailboxTimestamp;
      const expiresAt = addSeconds(
        input.now,
        WORKJET_DELEGATION_RESULT_TTL_SECONDS,
      ) as WorkjetMailboxTimestamp;
      const unsigned: WorkjetUnsignedRoutingEnvelope = {
        schemaVersion: 1,
        envelopeId: input.result.envelopeId,
        kind: "result",
        sourceWorkspaceId: identity.workspaceId,
        sourceEnvironmentId: input.environmentId,
        targetWorkspaceId: source.workspaceId,
        targetEnvironmentId: source.environmentId,
        createdAt,
        expiresAt,
      };
      const payload = {
        _tag: "result",
        result: input.result,
      } as const satisfies WorkjetMailboxPayload;

      const attempted = yield* Effect.result(
        identity
          .signRoutingEnvelope(unsigned)
          .pipe(Effect.flatMap((envelope) => store.enqueueOutbound(envelope, payload))),
      );
      if (attempted._tag === "Success") return "returned";
      // A bounded mailbox reason is the PERMANENT face of this path: a signing
      // rejection or a `malformed-envelope` encode failure re-derives the same
      // bytes on every retry and fails identically. A SQL failure is the
      // transient one, and is the whole reason the marker exists.
      return isWorkjetMailboxError(attempted.failure) ? "abandoned" : "deferred";
    });

  /**
   * Return a finalized result to the delegation's SOURCE address, and record
   * durably that it was returned.
   *
   * Same environment: append a `workjet.delegation.result` activity on the
   * source thread, reusing the same best-effort append the started/refused
   * traces use. Cross environment: enqueue a signed `result` envelope as pending
   * outbound. Either way the migration-049 marker is stamped on success, so the
   * redelivery scan holds exactly the returns that never landed — a transient
   * enqueue failure is no longer a silent loss.
   */
  const deliverResult = (input: {
    readonly delegation: WorkjetDelegation;
    readonly result: WorkjetDelegationResult;
    readonly environmentId: EnvironmentId;
    readonly now: string;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const delegation = input.delegation;
      const source = delegation.source;

      if (source.environmentId === input.environmentId) {
        yield* appendActivity({
          threadId: source.threadId,
          delegationId: delegation.delegationId,
          suffix: "result",
          kind: WORKJET_DELEGATION_RESULT_ACTIVITY_KIND,
          tone: input.result.outcome === "completed" ? "info" : "error",
          summary: "Workjet delegation result",
          payload: resultActivityPayload({ delegation, result: input.result }),
          createdAt: input.now,
        });
        resultsReturned += 1;
        // A local return has no outbound envelope to redeliver, so the marker
        // is what keeps the row out of the cross-environment retry scan.
        yield* markResultReturned(delegation.delegationId, input.now);
        return;
      }

      const outcome = yield* enqueueCrossEnvironmentResult(input);
      if (outcome === "returned") {
        resultsEnqueued += 1;
        yield* markResultReturned(delegation.delegationId, input.now);
        return;
      }
      if (outcome === "abandoned") {
        resultReturnsAbandoned += 1;
        yield* markResultReturnAbandoned(delegation.delegationId, input.now);
        yield* Effect.logWarning("Workjet delegation result enqueue abandoned");
        return;
      }
      // Unmarked on purpose: the redelivery scan owns it from here.
      yield* Effect.logWarning("Workjet delegation result enqueue deferred");
    });

  /**
   * Outcome of charging a delegation for the tokens its turn consumed.
   *
   * `passed` covers BOTH "the charge landed" and "the charge could not be read
   * or written this cycle": neither may gate the delegation, and the next cycle
   * re-derives the same numbers.
   */
  type UsageChargeOutcome =
    | { readonly _tag: "passed" }
    | {
        readonly _tag: "exceeded";
        readonly kind: WorkjetMailboxBudgetKind;
        readonly reason: "token-budget-exceeded" | "cost-budget-exceeded";
      };

  /**
   * Charge a delegation for its turn's real token usage.
   *
   * IDEMPOTENCY, without a marker column: the amount charged is the DELTA
   * between the turn's observed cumulative tokens and the total already
   * recorded on the row. A delegation runs exactly one turn, so its recorded
   * total converges on that turn's usage no matter how often the scan runs —
   * a retried completion (or a mid-run cycle followed by the final one) tops
   * the total up instead of adding a second full charge, and a repeat with no
   * new usage writes nothing at all.
   *
   * COST is always zero. No per-turn cost figure exists anywhere the executor
   * can reach: `projection_turns` carries none, the thread-detail usage
   * snapshots are token counts only, and the `UsageSummary` pipeline prices
   * provider transcripts on a (day, provider, model) grain that cannot be
   * attributed to a single turn. Recording a fabricated number would be worse
   * than recording none, so the cost ceiling is enforced by the store but never
   * driven by this executor.
   *
   * A delegation with neither ceiling records its usage and is never gated:
   * `recordDelegationUsage` only refuses against a ceiling that exists.
   */
  const chargeTurnUsage = (input: {
    readonly record: WorkjetDelegationRecord;
    readonly thread: OrchestrationThread;
    readonly turnId: string;
  }): Effect.Effect<UsageChargeOutcome> =>
    Effect.gen(function* () {
      const observed = turnTokenUsage(input.thread, input.turnId);
      if (observed <= 0) return { _tag: "passed" } as const;

      const accounting = yield* Effect.result(
        store.getDelegationAccounting(input.record.delegationId),
      );
      if (accounting._tag === "Failure") {
        // Charging without knowing what is already recorded would double-count.
        yield* Effect.logWarning("Workjet delegation usage charge deferred");
        return { _tag: "passed" } as const;
      }
      const already = Option.match(accounting.success, {
        onNone: () => 0,
        onSome: (totals) => totals.tokens,
      });
      const deltaTokens = Math.max(0, observed - already);
      if (deltaTokens === 0) return { _tag: "passed" } as const;

      const charged = yield* Effect.result(
        store.recordDelegationUsage(input.record.delegationId, deltaTokens, 0),
      );
      if (charged._tag === "Success") {
        usageRecorded += 1;
        usageTokensRecorded += deltaTokens;
        return { _tag: "passed" } as const;
      }
      const failure = charged.failure;
      if (isWorkjetMailboxError(failure) && failure.reason === "token-budget-exceeded") {
        return { _tag: "exceeded", kind: "tokens", reason: failure.reason } as const;
      }
      if (isWorkjetMailboxError(failure) && failure.reason === "cost-budget-exceeded") {
        return { _tag: "exceeded", kind: "cost", reason: failure.reason } as const;
      }
      // A SQL failure is not a budget verdict. Leave the row running.
      yield* Effect.logWarning("Workjet delegation usage charge deferred");
      return { _tag: "passed" } as const;
    });

  /**
   * Ask the engine to stop a turn whose delegation just ran out of budget.
   * Best-effort and derived-id, exactly like the activity appends: the
   * delegation is failed either way, and an engine that cannot interrupt must
   * not keep the row alive.
   */
  const interruptTurn = (input: {
    readonly delegationId: WorkjetDelegationId;
    readonly threadId: ThreadId;
    readonly turnId: string;
    readonly now: string;
  }) =>
    Effect.suspend(() =>
      engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: delegationTurnInterruptCommandId(input.delegationId),
        threadId: input.threadId,
        turnId: TurnId.make(input.turnId),
        createdAt: input.now,
      } as const satisfies OrchestrationCommand),
    ).pipe(Effect.ignore);

  /**
   * Terminate a delegation whose usage charge was refused by a ceiling.
   *
   * Unlike {@link refuse} this persists a bounded FAILED RESULT (the ceiling is
   * a turn outcome the delegator must be told about, not a delivery refusal),
   * reports it to the source through the normal result path, and emits the
   * `budget-exceeded` audit event — the live emit site the audit contract has
   * been carrying without one.
   */
  const failForBudget = (input: {
    readonly record: WorkjetDelegationRecord;
    readonly thread: OrchestrationThread;
    readonly turnId: string;
    readonly kind: WorkjetMailboxBudgetKind;
    readonly reason: "token-budget-exceeded" | "cost-budget-exceeded";
    /** The turn is still live and must be stopped before the row goes terminal. */
    readonly turnStillRunning: boolean;
    readonly environmentId: EnvironmentId;
    readonly now: string;
  }): Effect.Effect<ExecutionOutcome> =>
    Effect.gen(function* () {
      const delegation = input.record.delegation;
      if (input.turnStillRunning) {
        yield* interruptTurn({
          delegationId: delegation.delegationId,
          threadId: input.thread.id,
          turnId: input.turnId,
          now: input.now,
        });
        budgetInterrupts += 1;
      }

      const result = buildResult({
        delegation,
        outcome: "failed",
        envelopeId: delegationResultEnvelopeId(delegation.delegationId),
        now: input.now,
        budgetKind: input.kind,
      });
      const finalized = yield* store
        .finalizeDelegationResult({
          delegationId: delegation.delegationId,
          to: "failed",
          result,
          changedAt: input.now as WorkjetMailboxTimestamp,
        })
        .pipe(Effect.option);
      if (Option.isNone(finalized)) {
        // Cancelled or expired underneath us between the scan and here.
        return { _tag: "transient" } as const;
      }

      yield* deliverResult({
        delegation,
        result: finalized.value.result,
        environmentId: input.environmentId,
        now: input.now,
      });

      yield* emit({
        _tag: "budget-exceeded",
        occurredAt: input.now as WorkjetMailboxTimestamp,
        delegationId: delegation.delegationId,
        kind: input.kind,
      });
      // The same terminal-outcome event every other finalized delegation emits,
      // so a subscriber never has to special-case the budget path to learn that
      // the delegation is over.
      yield* emit({
        _tag: "delegation-completed",
        occurredAt: input.now as WorkjetMailboxTimestamp,
        delegationId: delegation.delegationId,
        envelopeId: delegation.envelopeId,
        source: auditAddress(delegation.source),
        target: auditAddress(delegation.target),
        outcome: "failed",
      });

      return { _tag: "failed", reason: input.reason } as const;
    });

  /**
   * Advance a `running` delegation whose target thread is LOCAL. The delegation
   * is completed ONLY when the exact turn this executor dispatched has ended:
   * the correlated user message's turn is the latest turn, that turn is no
   * longer running, and the session is not still driving it. A turn that ended
   * in error or interruption moves `running → failed`. Idempotent: the store
   * refuses a second finalize and returns the stored result.
   */
  const advanceRunning = (input: {
    readonly record: WorkjetDelegationRecord;
    readonly environmentId: EnvironmentId;
    readonly now: string;
  }): Effect.Effect<ExecutionOutcome> =>
    Effect.gen(function* () {
      const delegation = input.record.delegation;
      const environmentId = input.environmentId;

      if (delegation.target.environmentId !== environmentId) {
        // Only the machine that owns the target thread can observe its turn.
        return { _tag: "foreign-environment" } as const;
      }

      const threadOption = yield* query
        .getThreadDetailById(delegation.target.threadId)
        .pipe(Effect.option);
      if (Option.isNone(threadOption)) {
        return { _tag: "transient" } as const;
      }
      const thread = Option.getOrUndefined(threadOption.value);
      if (thread !== undefined && thread.deletedAt !== null) {
        // The target thread was DELETED mid-run. Its turn can never end, so
        // waiting for the budget-expiry backstop would strand the delegation for
        // the whole TTL. Fail it now with the explicit `target-thread-deleted`
        // reason (expiry remains the backstop for anything this misses). No
        // result is delivered: this is a refusal, not a turn outcome, and the
        // deleted thread is no place to append a trace.
        return yield* refuse({
          record: input.record,
          reason: "target-thread-deleted",
          threadId: null,
          now: input.now,
        });
      }
      if (thread === undefined) {
        // The read SUCCEEDED but the thread is absent entirely. Unlike a soft
        // delete this cannot be told apart from an eventually-consistent
        // projection gap for a thread we know we dispatched into, so it is held
        // `running` for the next cycle (and, ultimately, the expiry backstop)
        // rather than guessed terminal.
        return { _tag: "running-pending" } as const;
      }

      const turnId = dispatchedTurnId(thread, delegation.delegationId);
      if (turnId === null) {
        // The dispatched turn is not materialized in the projection yet.
        return { _tag: "running-pending" } as const;
      }
      const latest = thread.latestTurn;
      // The turn this executor dispatched has ENDED only when it is the latest
      // turn, is no longer running, and the session is no longer driving it.
      // Never complete on the strength of a DIFFERENT turn ending.
      const turnEnded =
        latest !== null &&
        latest.turnId === turnId &&
        latest.state !== "running" &&
        (thread.session?.activeTurnId ?? null) !== turnId;

      // Charged on EVERY cycle the turn is observable, not only at the end.
      // That is what makes the ceiling a real gate: a runaway turn is stopped
      // while it is still burning tokens rather than billed for afterwards.
      // The charge is a delta against the recorded total, so the mid-run and
      // the final charge together add up to the turn's usage exactly once.
      const charge = yield* chargeTurnUsage({ record: input.record, thread, turnId });
      if (charge._tag === "exceeded") {
        return yield* failForBudget({
          record: input.record,
          thread,
          turnId,
          kind: charge.kind,
          reason: charge.reason,
          turnStillRunning: !turnEnded,
          environmentId,
          now: input.now,
        });
      }

      if (!turnEnded || latest === null) {
        return { _tag: "running-pending" } as const;
      }

      const outcome: "completed" | "failed" = latest.state === "completed" ? "completed" : "failed";
      // An interrupted turn is a failed outcome with an EXPLICIT bounded reason,
      // distinct from a turn the target ended in error. The contract outcome is
      // still `failed`; the reason rides the result summary and the counters.
      const interrupted = latest.state === "interrupted";
      const result = buildResult({
        delegation,
        outcome,
        envelopeId: delegationResultEnvelopeId(delegation.delegationId),
        now: input.now,
        interrupted,
      });

      const finalized = yield* store
        .finalizeDelegationResult({
          delegationId: delegation.delegationId,
          to: outcome,
          result,
          changedAt: input.now as WorkjetMailboxTimestamp,
        })
        .pipe(Effect.option);
      if (Option.isNone(finalized)) {
        // The row moved underneath us (cancelled/expired) between the scan and
        // the finalize. A legitimate concurrent outcome, not a cycle failure.
        return { _tag: "transient" } as const;
      }

      // Deliver the STORED result: on an idempotent replay this is the original
      // result, so the source never sees two divergent envelopes.
      yield* deliverResult({
        delegation,
        result: finalized.value.result,
        environmentId,
        now: input.now,
      });

      // Emitted AFTER the durable finalize, carrying only the terminal outcome.
      yield* emit({
        _tag: "delegation-completed",
        occurredAt: input.now as WorkjetMailboxTimestamp,
        delegationId: delegation.delegationId,
        envelopeId: delegation.envelopeId,
        source: auditAddress(delegation.source),
        target: auditAddress(delegation.target),
        outcome,
      });

      return outcome === "completed"
        ? ({ _tag: "completed" } as const)
        : interrupted
          ? ({ _tag: "turn-interrupted" } as const)
          : ({ _tag: "turn-failed" } as const);
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
        case "version-unsupported":
          versionUnsupported += 1;
          break;
        case "retry-dispatch":
          dispatchRetries += 1;
          break;
        case "completed":
          completed += 1;
          break;
        case "turn-failed":
          turnFailures += 1;
          break;
        case "turn-interrupted":
          // An interruption is still a terminal turn failure; count it in both
          // the specific and the aggregate so existing failure totals hold.
          turnFailures += 1;
          turnInterrupted += 1;
          break;
        case "running-pending":
          runningPending += 1;
          break;
        case "awaiting-approval":
          awaitingApproval += 1;
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
            case "target-capability-escalation":
              targetCapabilityEscalation += 1;
              break;
            case "engine-rejected":
              engineRejected += 1;
              break;
            case "delivery-dead-lettered":
              deliveryDeadLettered += 1;
              break;
            case "token-budget-exceeded":
              tokenBudgetExceeded += 1;
              break;
            case "cost-budget-exceeded":
              costBudgetExceeded += 1;
              break;
          }
          break;
      }
    };

    /**
     * A by-state scan that tolerates an undecodable (version-skewed) row: the
     * store returns each row as either a decoded `record` or a bounded `corrupt`
     * marker, so one row the current schema cannot read is COUNTED and skipped
     * instead of aborting the whole batch. A transient store outage still fails
     * the read, which `Effect.option` folds into an empty batch for this cycle.
     */
    const scan = (state: "accepted" | "delivered" | "running") =>
      store
        .listDelegationRowsByState(state, WORKJET_DELEGATION_EXECUTOR_BATCH_SIZE)
        .pipe(
          Effect.option,
          Effect.map(Option.getOrElse(() => [] as ReadonlyArray<WorkjetDelegationRowResult>)),
        );

    /**
     * Result REDELIVERY, before anything else finalizes a delegation in this
     * cycle: a terminal delegation whose durable result was never handed to the
     * outbox (its enqueue failed transiently on the cycle that produced it, or
     * the process died between the finalize and the enqueue). Nothing used to
     * re-read those rows — the result stayed on the row and the source was
     * never told. The markers added by migration 049 make the set finite and
     * the retry idempotent: the result envelope id is derived from the
     * delegation id, so a duplicate enqueue collapses onto the same outbox row.
     *
     * Running FIRST also means a delegation finalized later in THIS cycle is
     * never attempted twice in one pass.
     */
    for (const row of yield* store
      .listDelegationsPendingResultReturn(WORKJET_DELEGATION_EXECUTOR_BATCH_SIZE)
      .pipe(
        Effect.option,
        Effect.map(Option.getOrElse(() => [] as ReadonlyArray<WorkjetDelegationResultReturnRow>)),
      )) {
      if (row._tag === "corrupt") {
        // The stored delegation or result no longer decodes through this
        // server's contract schema. The envelope can never be rebuilt, so the
        // retry is abandoned rather than looped forever; the row keeps its
        // durable result for a future version that can read it.
        yield* Effect.logWarning("Workjet delegation result row unreadable by this server version");
        yield* markResultReturnAbandoned(row.delegationId, now);
        resultReturnsAbandoned += 1;
        continue;
      }
      const delegation = row.record.delegation;
      if (delegation.source.environmentId === environmentId) {
        // A SAME-environment result was returned as a thread activity, which
        // leaves no outbound envelope to redeliver. Rows finalized before this
        // marker existed land here exactly once and are then stamped.
        yield* markResultReturned(row.record.delegationId, now);
        continue;
      }
      const outcome = yield* enqueueCrossEnvironmentResult({
        delegation,
        result: row.result,
        environmentId,
        now,
      });
      if (outcome === "returned") {
        resultsEnqueued += 1;
        resultRedeliveries += 1;
        yield* markResultReturned(row.record.delegationId, now);
        continue;
      }
      if (outcome === "abandoned") {
        resultReturnsAbandoned += 1;
        yield* markResultReturnAbandoned(row.record.delegationId, now);
        yield* Effect.logWarning("Workjet delegation result redelivery abandoned");
        continue;
      }
      yield* Effect.logWarning("Workjet delegation result redelivery deferred");
    }

    /**
     * `running` FIRST, and before any accept moves a fresh row into `running`:
     * this scan observes only delegations that were ALREADY running at cycle
     * start, so a turn dispatched later in this same cycle can never be mistaken
     * for one that has ended. It dispatches no turn and marks no thread busy, so
     * it is otherwise independent of the accept/deliver loops.
     */
    for (const entry of yield* scan("running")) {
      scanned += 1;
      if (entry._tag === "corrupt") {
        yield* Effect.logWarning("Workjet delegation row unreadable by this server version");
        record({ _tag: "version-unsupported" });
        continue;
      }
      const row = entry.record;
      if (row.terminal) continue;
      record(yield* advanceRunning({ record: row, environmentId, now }));
    }

    /**
     * `accepted` FIRST among the dispatch loops. Those rows are the ones a
     * previous process (or a previous cycle) already committed to running;
     * finishing them before accepting anything new keeps a restart from piling
     * new work on top of half-started work, and marks their threads busy for the
     * rest of the cycle.
     */
    for (const entry of yield* scan("accepted")) {
      scanned += 1;
      if (entry._tag === "corrupt") {
        yield* Effect.logWarning("Workjet delegation row unreadable by this server version");
        record({ _tag: "version-unsupported" });
        continue;
      }
      const row = entry.record;
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

    for (const entry of yield* scan("delivered")) {
      scanned += 1;
      if (entry._tag === "corrupt") {
        yield* Effect.logWarning("Workjet delegation row unreadable by this server version");
        record({ _tag: "version-unsupported" });
        continue;
      }
      const row = entry.record;
      if (row.terminal) continue;
      // Approval gate: a delegation whose human-approval gate is still `pending`
      // MUST NOT be accepted or run. It stays exactly where it is (`delivered`)
      // until a human approves it — the autonomous-escalation ceiling. Consulted
      // BEFORE resolveTarget so a pending gate is never mistaken for
      // backpressure, and BEFORE any transition, so nothing durable moves.
      const executable = yield* store
        .isDelegationExecutable(row.delegationId)
        .pipe(Effect.option, Effect.map(Option.getOrElse(() => false)));
      if (!executable) {
        // Announce the approval gate exactly once per delegation, not every
        // cycle the row waits in `delivered`.
        const announced = yield* Ref.get(approvalAnnounced);
        if (!announced.has(row.delegationId)) {
          yield* Ref.update(approvalAnnounced, (current) => {
            const next = new Set(current);
            if (next.size >= APPROVAL_ANNOUNCE_CAP) next.clear();
            next.add(row.delegationId);
            return next;
          });
          yield* emit({
            _tag: "delegation-approval-required",
            occurredAt: now as WorkjetMailboxTimestamp,
            delegationId: row.delegationId,
            envelopeId: row.delegation.envelopeId,
            source: auditAddress(row.delegation.source),
            target: auditAddress(row.delegation.target),
          });
        }
        record({ _tag: "awaiting-approval" });
        continue;
      }

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

    /**
     * Dead-letter reconciliation. A cross-environment delegation whose outbound
     * envelope exhausted its delivery budget (or expired) sits `dead` in the
     * outbox while its SOURCE-side delegation row is still `queued` — a state the
     * dispatch loops above never scan. Rather than leave it queued until the
     * budget-expiry backstop, fail it explicitly with `delivery-dead-lettered`,
     * leaving a bounded trace on the delegator's own (local) source thread, so a
     * task that could never leave this machine is a visible terminal outcome
     * instead of a silent drop. Only `delegation` envelopes reconcile: a dead
     * `result` envelope means a completed delegation's report could not be
     * delivered, which must not reopen or re-fail the finished delegation.
     * Idempotent: a delegation already terminal is skipped.
     *
     * Each row is examined EXACTLY ONCE. The scan is restricted to rows without
     * the migration-049 `reconciled_at_ms` marker and stamps every row it sees —
     * including the ones it deliberately skips — because a dead envelope is
     * never resurrected, so re-reading it on every ten-second cycle for the rest
     * of the row's life buys nothing. A row pinned before the marker existed is
     * unmarked, so it reconciles one last time (harmlessly: the check above is
     * idempotent) and is then stamped.
     */
    for (const outbox of yield* store
      .listUnreconciledOutboundByState("dead", WORKJET_DELEGATION_EXECUTOR_BATCH_SIZE)
      .pipe(
        Effect.option,
        Effect.map(Option.getOrElse(() => [] as ReadonlyArray<WorkjetOutboxRecord>)),
      )) {
      // Stamped for every disposition below, so the row leaves the scan set
      // whether it was reconciled, skipped as a `result` envelope, or found
      // already terminal.
      const markReconciled = store
        .markOutboundReconciled(outbox.envelopeId, now as WorkjetMailboxTimestamp)
        .pipe(Effect.ignore);
      if (outbox.payload._tag !== "delegation") {
        yield* markReconciled;
        continue;
      }
      const delegation = outbox.payload.delegation;
      const existing = yield* store
        .getDelegation(delegation.delegationId)
        .pipe(Effect.option, Effect.map(Option.flatten));
      if (Option.isNone(existing) || existing.value.terminal) {
        yield* markReconciled;
        continue;
      }
      const outcome = yield* refuse({
        record: existing.value,
        reason: "delivery-dead-lettered",
        threadId: delegation.source.threadId,
        now,
      });
      record(outcome);
      // A `transient` outcome means the delegation row moved underneath us, not
      // that this dead envelope still needs reconciling: it is terminal either
      // way, so the marker is stamped regardless.
      yield* markReconciled;
    }

    cycles += 1;
    lastCycleAt = now;
    return snapshot();
  });

  /**
   * Reassign a pending delegation to a different LOCAL target thread. A target
   * in another environment is refused (`unknown-target`): this server does not
   * host that thread and cannot run the task there. The store enforces the rest
   * of the invariant — only `delivered`/`needs-input` may move, everything
   * terminal or in-flight is `invalid-state-transition` — so a running or
   * finished task is never restarted on a second thread.
   */
  const reassign = (input: {
    readonly delegationId: WorkjetDelegationId;
    readonly newTarget: WorkjetWorkerAddress;
  }): Effect.Effect<WorkjetDelegationRecord, WorkjetMailboxStoreError> =>
    Effect.gen(function* () {
      const environmentId = yield* sources.environmentId;
      if (input.newTarget.environmentId !== environmentId) {
        return yield* new WorkjetMailboxError({ reason: "unknown-target" });
      }
      const now = yield* sources.nowIso;
      return yield* store.reassignDelegation(
        input.delegationId,
        input.newTarget,
        now as WorkjetMailboxTimestamp,
      );
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
    reassign,
  });
});

export const makeWorkjetDelegationExecutor = Effect.fn("WorkjetDelegationExecutor.make")(
  function* () {
    const environment = yield* ServerEnvironment;
    const auditEmitter = yield* WorkjetMailboxAuditEmitter;
    return yield* makeWorkjetDelegationExecutorWithSources({
      nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      environmentId: environment.getEnvironmentId,
      audit: { emit: auditEmitter.publish },
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
