/**
 * Every case here is a way a thread could reach the WRONG native instance or
 * module, which is the only thing this resolver exists to prevent. A test that
 * only proved the happy path would leave the resolver free to fall back to
 * "some link, some connection" and still look green.
 */
import {
  EnvironmentId,
  ThreadId,
  WorkjetBusinessOsObjectId,
  WorkjetBusinessOsObjectKind,
  WorkjetConnectionId,
  WorkjetCrossModeLinkId,
  type CtoxAppModuleId,
  type CtoxManagedInstanceId,
  type WorkjetCrossModeLink,
} from "@workjet/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  WorkjetCrossModeLinkStore,
  WorkjetCrossModeLinkStoreLive,
} from "../crossmode/WorkjetCrossModeLinkStore.ts";
import { bindCtoxConnectionInstance } from "./CtoxConnectionBinding.ts";
import { resolveCtoxThreadScope, type CtoxThreadScopeError } from "./CtoxThreadScope.ts";

const ENVIRONMENT = EnvironmentId.make("environment-local");
const OTHER_ENVIRONMENT = EnvironmentId.make("environment-elsewhere");
const INSTANCE: CtoxManagedInstanceId = "paired:manual_pairing:office-1";
const OTHER_INSTANCE: CtoxManagedInstanceId = "paired:manual_pairing:office-2";
const MODULE = "crm" as CtoxAppModuleId;
const THREAD = ThreadId.make("thread-linked");
const CONNECTION = WorkjetConnectionId.make("connection-office-1");
const NOW = 1_800_000_000_000;

const makeLink = (options: {
  readonly id: string;
  readonly objectId?: string;
  readonly threadId?: ThreadId;
  readonly environmentId?: EnvironmentId;
  readonly instanceId?: CtoxManagedInstanceId;
  readonly expiresAt?: string;
}): WorkjetCrossModeLink => ({
  schemaVersion: 1,
  linkId: WorkjetCrossModeLinkId.make(`wjx-0000000000-${options.id}`),
  ctox: {
    schemaVersion: 1,
    instanceId: options.instanceId ?? INSTANCE,
    moduleId: MODULE,
    objectKind: WorkjetBusinessOsObjectKind.make("deal"),
    objectId: WorkjetBusinessOsObjectId.make(options.objectId ?? `deal_${options.id}`),
  },
  code: {
    schemaVersion: 1,
    environmentId: options.environmentId ?? ENVIRONMENT,
    threadId: options.threadId ?? THREAD,
  },
  presentation: { schemaVersion: 1, title: "ACME Q3 renewal" },
  createdAt: "2026-08-19T10:00:00.000Z",
  ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
});

const boundThread = { connectionId: CONNECTION, instanceId: INSTANCE as string };

const testLayer = Layer.mergeAll(
  WorkjetCrossModeLinkStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);

/** Resolve and return the refusal reason, failing loudly on an unexpected pass. */
const refusal = <R>(
  effect: Effect.Effect<unknown, CtoxThreadScopeError, R>,
): Effect.Effect<CtoxThreadScopeError["reason"], never, R> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error.reason,
      onSuccess: () => "UNEXPECTEDLY-RESOLVED" as CtoxThreadScopeError["reason"],
    }),
  );

it.effect("resolves the module and record a linked, bound thread is allowed to act on", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetCrossModeLinkStore;
    yield* store.createOrSelect(makeLink({ id: "aaaaa1" }));
    yield* bindCtoxConnectionInstance(CONNECTION, INSTANCE);

    const scope = yield* resolveCtoxThreadScope({
      threadId: THREAD,
      environmentId: ENVIRONMENT,
      binding: boundThread,
      nowMillis: NOW,
    });

    assert.deepEqual(scope, {
      connectionId: CONNECTION,
      ctoxInstanceId: INSTANCE,
      // The module comes from the link, never from a constant or a title.
      task: { module_id: MODULE, record_id: "deal_aaaaa1" },
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses every thread that has no unambiguous claim on a native scope", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetCrossModeLinkStore;
    yield* bindCtoxConnectionInstance(CONNECTION, INSTANCE);

    // A thread with no Business OS link at all: a general Dev project. It must
    // be refused rather than silently redefined into some Business OS app.
    assert.equal(
      yield* refusal(
        resolveCtoxThreadScope({
          threadId: ThreadId.make("thread-unlinked"),
          environmentId: ENVIRONMENT,
          binding: boundThread,
          nowMillis: NOW,
        }),
      ),
      "no-business-os-link",
    );

    // No capability binding: the resolver must NOT go looking for a connection.
    yield* store.createOrSelect(makeLink({ id: "aaaaa2" }));
    assert.equal(
      yield* refusal(
        resolveCtoxThreadScope({
          threadId: THREAD,
          environmentId: ENVIRONMENT,
          binding: undefined,
          nowMillis: NOW,
        }),
      ),
      "no-thread-binding",
    );

    // A link created under another Workjet authority is not ours to execute.
    assert.equal(
      yield* refusal(
        resolveCtoxThreadScope({
          threadId: THREAD,
          environmentId: OTHER_ENVIRONMENT,
          binding: boundThread,
          nowMillis: NOW,
        }),
      ),
      "link-environment-mismatch",
    );

    // The thread is bound to another instance than the link names. This is the
    // "global selection switched to B while the thread belongs to A" case.
    assert.equal(
      yield* refusal(
        resolveCtoxThreadScope({
          threadId: THREAD,
          environmentId: ENVIRONMENT,
          binding: { connectionId: CONNECTION, instanceId: OTHER_INSTANCE },
          nowMillis: NOW,
        }),
      ),
      "instance-mismatch",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("treats an expiry as an expiry, and its absence as no expiry", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetCrossModeLinkStore;
    yield* bindCtoxConnectionInstance(CONNECTION, INSTANCE);
    const expired = ThreadId.make("thread-expired");
    yield* store.createOrSelect(
      makeLink({ id: "bbbbb1", threadId: expired, expiresAt: "2026-08-19T12:00:00.000Z" }),
    );

    assert.equal(
      yield* refusal(
        resolveCtoxThreadScope({
          threadId: expired,
          environmentId: ENVIRONMENT,
          binding: boundThread,
          nowMillis: NOW,
        }),
      ),
      "link-expired",
    );

    // The ordinary link carries no expiry at all. `null` means "no expiry",
    // never "expired" — a resolver that read it the other way would refuse
    // every normal thread, and the case above would still pass.
    yield* store.createOrSelect(makeLink({ id: "bbbbb2" }));
    const scope = yield* resolveCtoxThreadScope({
      threadId: THREAD,
      environmentId: ENVIRONMENT,
      binding: boundThread,
      nowMillis: NOW,
    });
    assert.equal(scope.task.module_id, MODULE);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a connection whose durable pin names a different instance", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetCrossModeLinkStore;
    yield* store.createOrSelect(makeLink({ id: "ccccc1" }));
    // Migration 59 pins first-writer-wins and never releases. A connection that
    // has always meant office-2 cannot be borrowed for an office-1 thread, even
    // though the thread's own binding claims otherwise.
    yield* bindCtoxConnectionInstance(CONNECTION, OTHER_INSTANCE);

    assert.equal(
      yield* refusal(
        resolveCtoxThreadScope({
          threadId: THREAD,
          environmentId: ENVIRONMENT,
          binding: boundThread,
          nowMillis: NOW,
        }),
      ),
      "connection-unverified",
    );
  }).pipe(Effect.provide(testLayer)),
);
