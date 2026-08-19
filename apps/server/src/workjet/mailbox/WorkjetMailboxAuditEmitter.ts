// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The bounded, redacted audit/observability event stream for the Workjet
 * mailbox subsystem (docs/workjet-plan.md Wave 5).
 *
 * This is a small dedicated bounded pub-sub, built the same way the resource
 * telemetry stream is (a sliding {@link PubSub} plus a subscribe-before-snapshot
 * handoff), rather than a second telemetry channel. It is the SINGLE place a
 * mailbox audit event is published; the delivery, transport, and executor
 * services call {@link WorkjetMailboxAuditEmitterShape.publish} at their existing
 * best-effort effect points AFTER the durable write, never before.
 *
 * Two disciplines are enforced here so a caller can emit blindly:
 *
 * 1. REDACTION is structural. The published value is a
 *    {@link WorkjetMailboxAuditEvent}, whose every field is a bounded id, a
 *    closed literal, an integer, or a timestamp. There is no field for prompt
 *    text, a sealed payload reference, artifact bytes, a secret, or a provider
 *    payload, so none can travel.
 * 2. EMISSION is best-effort. `publish` never fails and never throws: it stamps
 *    a monotone sequence, records the event in a bounded ring buffer for
 *    replay-on-subscribe, and offers it to the sliding pub-sub, swallowing any
 *    defect. A broken emitter must never fail the delivery, transition, or
 *    transport operation that produced the event — mirroring the best-effort
 *    thread-activity append the same services already use.
 */
import type { WorkjetMailboxAuditEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/**
 * How many recent events the ring buffer replays to a fresh subscriber, and the
 * sliding capacity of the live pub-sub. Bounded so neither the buffer nor a slow
 * subscriber can grow without limit: an overwhelmed subscriber drops the OLDEST
 * live events (a gap it can detect from the monotone `sequence`), never blocking
 * the publisher.
 */
export const WORKJET_MAILBOX_AUDIT_BUFFER_CAPACITY = 128;

/** Distributive `Omit` so each union variant keeps its own discriminant/fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The event minus the fields the emitter itself stamps. A caller describes WHAT
 * happened; the emitter owns the monotone `sequence` and the `schemaVersion`.
 */
export type WorkjetMailboxAuditEventInput = DistributiveOmit<
  WorkjetMailboxAuditEvent,
  "sequence" | "schemaVersion"
>;

export interface WorkjetMailboxAuditSubscription {
  /** Recent events (oldest first), for replay-on-connect. Bounded. */
  readonly recent: ReadonlyArray<WorkjetMailboxAuditEvent>;
  /** The live tail of events published after the subscription was taken. */
  readonly changes: Stream.Stream<WorkjetMailboxAuditEvent>;
}

export interface WorkjetMailboxAuditEmitterShape {
  /**
   * Publish one redacted audit event. Best-effort and infallible: it never
   * fails the caller's operation. The emitter stamps the sequence and schema
   * version, so the caller supplies only the event body.
   */
  readonly publish: (event: WorkjetMailboxAuditEventInput) => Effect.Effect<void>;
  /**
   * Subscribe: a bounded replay of recent events plus a live tail. The snapshot
   * is captured before the subscription so no event is missed or duplicated
   * across the handoff.
   */
  readonly subscribe: Effect.Effect<WorkjetMailboxAuditSubscription, never, Scope.Scope>;
}

export class WorkjetMailboxAuditEmitter extends Context.Service<
  WorkjetMailboxAuditEmitter,
  WorkjetMailboxAuditEmitterShape
>()("t3/workjet/mailbox/WorkjetMailboxAuditEmitter") {}

/**
 * A minimal sink the mailbox services depend on instead of the full emitter, so
 * a unit test can inject a capturing double without constructing the pub-sub.
 * `emit` is best-effort by construction.
 */
export interface WorkjetMailboxAuditSink {
  readonly emit: (event: WorkjetMailboxAuditEventInput) => Effect.Effect<void>;
}

/** A sink that discards every event. The default when no emitter is injected. */
export const noopWorkjetMailboxAuditSink: WorkjetMailboxAuditSink = {
  emit: () => Effect.void,
};

/**
 * Wrap a possibly-absent sink into an always-safe emit: a missing sink is a
 * no-op, and any defect the sink raises is swallowed, so emission can never
 * fail the surrounding durable operation.
 */
export const emitAudit = (
  sink: WorkjetMailboxAuditSink | undefined,
  event: WorkjetMailboxAuditEventInput,
): Effect.Effect<void> =>
  (sink ?? noopWorkjetMailboxAuditSink)
    .emit(event)
    // `ignore` swallows a typed failure (mirroring the best-effort activity
    // append); `catchDefect` additionally swallows a genuinely throwing sink, so
    // a broken emitter can never fail the surrounding durable operation.
    .pipe(
      Effect.ignore,
      Effect.catchDefect(() => Effect.void),
    );

export const makeWorkjetMailboxAuditEmitter = Effect.fn("WorkjetMailboxAuditEmitter.make")(
  function* () {
    const changes = yield* PubSub.sliding<WorkjetMailboxAuditEvent>(
      WORKJET_MAILBOX_AUDIT_BUFFER_CAPACITY,
    );
    const buffer = yield* Ref.make<ReadonlyArray<WorkjetMailboxAuditEvent>>([]);
    const sequence = yield* Ref.make(0);
    // Serializes the sequence stamp + buffer append + publish so two concurrent
    // emits never interleave a sequence number or reorder the ring buffer, and so
    // a subscriber's snapshot is consistent with the tail it then receives.
    const mutex = yield* Semaphore.make(1);

    const publish: WorkjetMailboxAuditEmitterShape["publish"] = (event) =>
      mutex
        .withPermits(1)(
          Effect.gen(function* () {
            const next = (yield* Ref.updateAndGet(sequence, (value) => value + 1)) - 1;
            const stamped = {
              ...event,
              schemaVersion: 1,
              sequence: next,
            } as WorkjetMailboxAuditEvent;
            yield* Ref.update(buffer, (current) => {
              const appended = [...current, stamped];
              return appended.length > WORKJET_MAILBOX_AUDIT_BUFFER_CAPACITY
                ? appended.slice(appended.length - WORKJET_MAILBOX_AUDIT_BUFFER_CAPACITY)
                : appended;
            });
            yield* PubSub.publish(changes, stamped);
          }),
        )
        // Best-effort: a broken pub-sub or a cancelled fiber must not fail the
        // delivery/transition/transport operation that produced the event.
        .pipe(Effect.ignore);

    const subscribe: WorkjetMailboxAuditEmitterShape["subscribe"] = mutex.withPermits(1)(
      Effect.gen(function* () {
        const recent = yield* Ref.get(buffer);
        const subscription = yield* PubSub.subscribe(changes);
        return {
          recent,
          changes: Stream.fromSubscription(subscription),
        } satisfies WorkjetMailboxAuditSubscription;
      }),
    );

    return WorkjetMailboxAuditEmitter.of({ publish, subscribe });
  },
);

export const layer = Layer.effect(WorkjetMailboxAuditEmitter, makeWorkjetMailboxAuditEmitter());
