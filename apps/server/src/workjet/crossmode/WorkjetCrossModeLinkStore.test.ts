import {
  EnvironmentId,
  ThreadId,
  WorkjetBusinessOsObjectId,
  WorkjetBusinessOsObjectKind,
  WorkjetCrossModeLinkId,
  type CtoxAppModuleId,
  type CtoxManagedInstanceId,
  type WorkjetCrossModeCtoxRef,
  type WorkjetCrossModeLink,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  WorkjetCrossModeLinkStore,
  WorkjetCrossModeLinkStoreLive,
  boundCrossModeStoreError,
  isWorkjetCrossModeError,
} from "./WorkjetCrossModeLinkStore.ts";

const ENVIRONMENT = EnvironmentId.make("environment-local");
const INSTANCE: CtoxManagedInstanceId = "paired:manual_pairing:office-1";
const OTHER_INSTANCE: CtoxManagedInstanceId = "paired:manual_pairing:office-2";
const MODULE = "crm" as CtoxAppModuleId;

const T0 = "2026-08-19T10:00:00.000Z";
const T1 = "2026-08-19T11:00:00.000Z";
const T2 = "2026-08-19T12:00:00.000Z";

const linkId = (suffix: string): WorkjetCrossModeLinkId =>
  WorkjetCrossModeLinkId.make(`wjx-0000000000-${suffix}`);

const ctoxRef = (options: {
  readonly objectId: string;
  readonly instanceId?: CtoxManagedInstanceId;
}): WorkjetCrossModeCtoxRef => ({
  schemaVersion: 1,
  instanceId: options.instanceId ?? INSTANCE,
  moduleId: MODULE,
  objectKind: WorkjetBusinessOsObjectKind.make("deal"),
  objectId: WorkjetBusinessOsObjectId.make(options.objectId),
});

const makeLink = (options: {
  readonly id: string;
  readonly objectId: string;
  readonly threadId: string;
  readonly instanceId?: CtoxManagedInstanceId;
  readonly createdAt?: string;
  readonly title?: string;
  readonly expiresAt?: string;
}): WorkjetCrossModeLink => ({
  schemaVersion: 1,
  linkId: linkId(options.id),
  ctox: ctoxRef({
    objectId: options.objectId,
    ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
  }),
  code: {
    schemaVersion: 1,
    environmentId: ENVIRONMENT,
    threadId: ThreadId.make(options.threadId),
  },
  presentation: { schemaVersion: 1, title: options.title ?? "ACME Q3 renewal" },
  createdAt: options.createdAt ?? T0,
  ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
});

const testLayer = Layer.mergeAll(
  WorkjetCrossModeLinkStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);

it.effect("creates a link and round-trips its typed references through the durable row", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetCrossModeLinkStore;
    const link = makeLink({
      id: "aaaaa1",
      objectId: "deal_4711",
      threadId: "thread-1",
      expiresAt: T2,
    });

    const outcome = yield* store.createOrSelect(link);
    assert.equal(outcome._tag, "created");
    assert.deepEqual(outcome.record.link, link);
    assert.isNotNull(outcome.record.expiresAtMillis);

    const byId = yield* store.getById(link.linkId);
    assert.deepEqual(Option.getOrThrow(byId).link, link);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("is idempotent on the Business OS object: a second delegation SELECTS, never forks", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetCrossModeLinkStore;
    const first = makeLink({ id: "bbbbb1", objectId: "deal_4711", threadId: "thread-1" });

    const created = yield* store.createOrSelect(first);
    assert.equal(created._tag, "created");

    // The same object, proposed with a DIFFERENT link id and a DIFFERENT thread:
    // this is the second "Delegate to Code" click, and it must return the thread
    // that already implements the object rather than a second one.
    const second = makeLink({
      id: "bbbbb2",
      objectId: "deal_4711",
      threadId: "thread-2",
      createdAt: T1,
      title: "A different label",
    });
    const selected = yield* store.createOrSelect(second);
    assert.equal(selected._tag, "existing");
    assert.equal(selected.record.linkId, first.linkId);
    assert.equal(selected.record.link.code.threadId, first.code.threadId);
    // The stored link is returned untouched: the caller's proposed presentation
    // does not overwrite the one already on record.
    assert.equal(selected.record.link.presentation.title, first.presentation.title);

    const all = yield* store.list(100);
    assert.equal(all.length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("looks a link up from EITHER side", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetCrossModeLinkStore;
    const link = makeLink({ id: "ccccc1", objectId: "deal_4711", threadId: "thread-1" });
    yield* store.createOrSelect(link);

    const fromBusinessOs = yield* store.getByObject(link.ctox);
    assert.equal(Option.getOrThrow(fromBusinessOs).linkId, link.linkId);

    const fromCode = yield* store.getByThread(link.code.threadId);
    assert.equal(Option.getOrThrow(fromCode).linkId, link.linkId);

    // Neither direction answers for an unrelated counterpart.
    assert.isTrue(Option.isNone(yield* store.getByObject(ctoxRef({ objectId: "deal_9999" }))));
    assert.isTrue(Option.isNone(yield* store.getByThread(ThreadId.make("thread-unrelated"))));
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "separates authorities: the same object id under another CTOX instance is its own link",
  () =>
    Effect.gen(function* () {
      const store = yield* WorkjetCrossModeLinkStore;
      const here = makeLink({ id: "ddddd1", objectId: "deal_4711", threadId: "thread-1" });
      const elsewhere = makeLink({
        id: "ddddd2",
        objectId: "deal_4711",
        threadId: "thread-2",
        instanceId: OTHER_INSTANCE,
        createdAt: T1,
      });

      assert.equal((yield* store.createOrSelect(here))._tag, "created");
      assert.equal((yield* store.createOrSelect(elsewhere))._tag, "created");

      const fromHere = yield* store.getByObject(here.ctox);
      assert.equal(Option.getOrThrow(fromHere).link.code.threadId, here.code.threadId);
      const fromElsewhere = yield* store.getByObject(elsewhere.ctox);
      assert.equal(Option.getOrThrow(fromElsewhere).link.code.threadId, elsewhere.code.threadId);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses to give one Code thread a second, conflicting counterpart", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetCrossModeLinkStore;
    yield* store.createOrSelect(
      makeLink({ id: "eeeee1", objectId: "deal_4711", threadId: "thread-1" }),
    );

    const conflict = yield* store
      .createOrSelect(makeLink({ id: "eeeee2", objectId: "deal_4712", threadId: "thread-1" }))
      .pipe(Effect.result);
    assert.isTrue(conflict._tag === "Failure");
    if (conflict._tag !== "Failure") return;
    const cause = conflict.failure;
    assert.isTrue(isWorkjetCrossModeError(cause));
    assert.equal(boundCrossModeStoreError(cause).reason, "thread-already-linked");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lists newest first and honours the bound", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetCrossModeLinkStore;
    yield* store.createOrSelect(
      makeLink({ id: "fffff1", objectId: "deal_1", threadId: "thread-1", createdAt: T0 }),
    );
    yield* store.createOrSelect(
      makeLink({ id: "fffff2", objectId: "deal_2", threadId: "thread-2", createdAt: T1 }),
    );
    yield* store.createOrSelect(
      makeLink({ id: "fffff3", objectId: "deal_3", threadId: "thread-3", createdAt: T2 }),
    );

    const all = yield* store.list(100);
    assert.deepEqual(
      all.map((record) => record.link.ctox.objectId),
      ["deal_3", "deal_2", "deal_1"],
    );

    const bounded = yield* store.list(2);
    assert.equal(bounded.length, 2);
    assert.equal(bounded[0]?.link.ctox.objectId, "deal_3");
  }).pipe(Effect.provide(testLayer)),
);
