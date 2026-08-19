import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  WorkjetEnvelopeId,
  WorkjetMeshWorkspaceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import {
  makeWorkjetMailboxAuditEmitter,
  WORKJET_MAILBOX_AUDIT_BUFFER_CAPACITY,
  type WorkjetMailboxAuditEventInput,
} from "./WorkjetMailboxAuditEmitter.ts";

const WORKSPACE = WorkjetMeshWorkspaceId.make("workjet-mesh-room-1");
const ENVIRONMENT = EnvironmentId.make("environment-local");
const ADDRESS = {
  workspaceId: WORKSPACE,
  environmentId: ENVIRONMENT,
  threadId: ThreadId.make("t"),
};
const NOW = "2026-08-19T12:00:00.000Z";

const enqueued = (index: number): WorkjetMailboxAuditEventInput => ({
  _tag: "envelope-enqueued",
  occurredAt: NOW,
  envelopeId: WorkjetEnvelopeId.make(`wjm-envelope-${String(index).padStart(6, "0")}`),
  source: ADDRESS,
  target: ADDRESS,
});

it.effect("stamps a monotone sequence and the schema version on each event", () =>
  Effect.gen(function* () {
    const emitter = yield* makeWorkjetMailboxAuditEmitter();
    yield* emitter.publish(enqueued(1));
    yield* emitter.publish(enqueued(2));
    yield* emitter.publish(enqueued(3));

    const { recent } = yield* emitter.subscribe;
    assert.deepEqual(
      recent.map((event) => event.sequence),
      [0, 1, 2],
    );
    assert.isTrue(recent.every((event) => event.schemaVersion === 1));
  }).pipe(Effect.scoped),
);

it.effect("replays the recent buffer and then delivers the live tail", () =>
  Effect.gen(function* () {
    const emitter = yield* makeWorkjetMailboxAuditEmitter();
    yield* emitter.publish(enqueued(1));

    const { recent, changes } = yield* emitter.subscribe;
    // The pre-subscription event is replayed from the ring buffer.
    assert.equal(recent.length, 1);

    // A collector for the live tail; publish AFTER it is listening.
    const collector = yield* changes.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* emitter.publish(enqueued(2));
    yield* emitter.publish(enqueued(3));

    const live = Array.from(yield* Fiber.join(collector));
    assert.deepEqual(
      live.map((event) => event.sequence),
      [1, 2],
    );
  }).pipe(Effect.scoped),
);

it.effect("bounds the replay buffer to its capacity (drops the oldest)", () =>
  Effect.gen(function* () {
    const emitter = yield* makeWorkjetMailboxAuditEmitter();
    const total = WORKJET_MAILBOX_AUDIT_BUFFER_CAPACITY + 5;
    yield* Effect.forEach(
      Array.from({ length: total }, (_, index) => index + 1),
      (index) => emitter.publish(enqueued(index)),
      { discard: true },
    );

    const { recent } = yield* emitter.subscribe;
    assert.equal(recent.length, WORKJET_MAILBOX_AUDIT_BUFFER_CAPACITY);
    // The buffer keeps the newest window: the first retained sequence is total-capacity.
    assert.equal(recent[0]?.sequence, total - WORKJET_MAILBOX_AUDIT_BUFFER_CAPACITY);
    assert.equal(recent[recent.length - 1]?.sequence, total - 1);
  }).pipe(Effect.scoped),
);

it.effect("publish is best-effort: it never fails its caller", () =>
  Effect.gen(function* () {
    const emitter = yield* makeWorkjetMailboxAuditEmitter();
    // publish has no error channel, so a caller can emit blindly.
    const result = yield* emitter.publish(enqueued(1)).pipe(Effect.result);
    assert.isTrue(Result.isSuccess(result));
  }).pipe(Effect.scoped),
);
