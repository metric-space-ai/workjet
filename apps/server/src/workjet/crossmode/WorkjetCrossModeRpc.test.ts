import {
  EnvironmentId,
  ThreadId,
  WorkjetBusinessOsObjectId,
  WorkjetBusinessOsObjectKind,
  type CtoxAppModuleId,
  type CtoxManagedInstanceId,
  type OrchestrationThread,
  type WorkjetCrossModeActivityPayload,
  type WorkjetCrossModeCtoxRef,
  type WorkjetCrossModeEvidence,
  type WorkjetCrossModeLinkId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  WorkjetCrossModeLinkStore,
  WorkjetCrossModeLinkStoreLive,
} from "./WorkjetCrossModeLinkStore.ts";
import {
  workjetCrossModeCtoxPortUnavailable,
  type WorkjetCrossModeCtoxCommand,
  type WorkjetCrossModeCtoxPortShape,
} from "./WorkjetCrossModeCtoxPort.ts";
import {
  composeCrossModeSeedMessage,
  makeWorkjetCrossModeRpcHandlers,
  WORKJET_CROSS_MODE_LINKED_ACTIVITY_KIND,
  WORKJET_CROSS_MODE_RETURNED_ACTIVITY_KIND,
  type WorkjetCrossModeThreadPort,
} from "./WorkjetCrossModeRpc.ts";

const ENVIRONMENT = EnvironmentId.make("environment-local");
const OTHER_ENVIRONMENT = EnvironmentId.make("environment-remote");
const INSTANCE: CtoxManagedInstanceId = "paired:manual_pairing:office-1";
const INVENTED_INSTANCE: CtoxManagedInstanceId = "paired:manual_pairing:attacker";
const MODULE = "crm" as CtoxAppModuleId;
const HOST_THREAD = ThreadId.make("thread-host");
const NOW = "2026-08-19T10:00:00.000Z";

const ctoxRef = (
  options: {
    readonly objectId?: string;
    readonly instanceId?: CtoxManagedInstanceId;
  } = {},
): WorkjetCrossModeCtoxRef => ({
  schemaVersion: 1,
  instanceId: options.instanceId ?? INSTANCE,
  moduleId: MODULE,
  objectKind: WorkjetBusinessOsObjectKind.make("deal"),
  objectId: WorkjetBusinessOsObjectId.make(options.objectId ?? "deal_4711"),
});

const PRESENTATION = { schemaVersion: 1, title: "ACME Q3 renewal" } as const;
const CONTEXT = { schemaVersion: 1, brief: "Implement the renewal discount rule." } as const;

const EVIDENCE: WorkjetCrossModeEvidence = {
  schemaVersion: 1,
  summary: "Renewal terms implemented and tested.",
  artifacts: { schemaVersion: 1, commitHashes: [], paths: [] },
};

/**
 * A thread projection double carrying only the fields the handlers read. The
 * real `OrchestrationThread` is far wider; widening the double would test the
 * projection rather than the authorization rule.
 */
const thread = (options: {
  readonly threadId: ThreadId;
  readonly role?: "orchestrator" | "standard";
  readonly deleted?: boolean;
}): OrchestrationThread =>
  ({
    threadId: options.threadId,
    projectId: "project-1",
    title: "Host",
    deletedAt: options.deleted === true ? NOW : null,
    branch: null,
    modelSelection: { provider: "claude" },
    runtimeMode: "local",
    interactionMode: "chat",
    messages: [],
    workjetConfig: { role: options.role ?? "orchestrator" },
  }) as unknown as OrchestrationThread;

interface Recorder {
  readonly created: ReadonlyArray<{ readonly title: string; readonly seedMessage: string }>;
  readonly deleted: ReadonlyArray<ThreadId>;
  readonly activities: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly payload: WorkjetCrossModeActivityPayload;
  }>;
  readonly dispatched: ReadonlyArray<WorkjetCrossModeCtoxCommand>;
}

const EMPTY_RECORDER: Recorder = { created: [], deleted: [], activities: [], dispatched: [] };

/** A CTOX port that vouches for exactly one instance and executes every command. */
const verifyingPort = (
  recorder: Ref.Ref<Recorder>,
  options: { readonly awaitingApproval?: boolean } = {},
): WorkjetCrossModeCtoxPortShape => ({
  verifyAuthority: (instanceId) => Effect.succeed(instanceId === INSTANCE),
  dispatch: (command) =>
    Ref.update(recorder, (current) => ({
      ...current,
      dispatched: [...current.dispatched, command],
    })).pipe(
      Effect.as(
        options.awaitingApproval === true
          ? ({ _tag: "awaiting-approval" } as const)
          : ({ _tag: "dispatched" } as const),
      ),
    ),
});

const threadPort = (
  recorder: Ref.Ref<Recorder>,
  nextThreadIds: ReadonlyArray<string>,
): WorkjetCrossModeThreadPort => {
  const queue = [...nextThreadIds];
  return {
    createLinkedThread: (input) =>
      Ref.update(recorder, (current) => ({
        ...current,
        created: [...current.created, { title: input.title, seedMessage: input.seedMessage }],
      })).pipe(Effect.as(ThreadId.make(queue.shift() ?? "thread-overflow"))),
    deleteThread: (threadId) =>
      Ref.update(recorder, (current) => ({
        ...current,
        deleted: [...current.deleted, threadId],
      })),
    appendActivity: (input) =>
      Ref.update(recorder, (current) => ({
        ...current,
        activities: [
          ...current.activities,
          { threadId: input.threadId, kind: input.kind, payload: input.payload },
        ],
      })),
  };
};

const harness = (
  options: {
    readonly ctox?: WorkjetCrossModeCtoxPortShape;
    readonly threads?: ReadonlyArray<string>;
    readonly hostRole?: "orchestrator" | "standard";
    readonly hostDeleted?: boolean;
    readonly liveThreads?: ReadonlyArray<string>;
    readonly nowIso?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const links = yield* WorkjetCrossModeLinkStore;
    const recorder = yield* Ref.make(EMPTY_RECORDER);
    const uuids = yield* Ref.make(0);
    const live = new Set(options.liveThreads ?? ["thread-1", "thread-2"]);

    const handlers = makeWorkjetCrossModeRpcHandlers({
      links,
      ctox: options.ctox ?? verifyingPort(recorder),
      threads: threadPort(recorder, options.threads ?? ["thread-1", "thread-2"]),
      query: {
        getThreadDetailById: (threadId) => {
          if (threadId === HOST_THREAD) {
            return Effect.succeed(
              Option.some(
                thread({
                  threadId,
                  ...(options.hostRole !== undefined ? { role: options.hostRole } : {}),
                  ...(options.hostDeleted !== undefined ? { deleted: options.hostDeleted } : {}),
                }),
              ),
            );
          }
          return Effect.succeed(
            live.has(threadId)
              ? Option.some(thread({ threadId, role: "standard" }))
              : Option.none(),
          );
        },
      },
      environmentId: ENVIRONMENT,
      nowIso: Effect.succeed(options.nowIso ?? NOW),
      randomUUID: Ref.updateAndGet(uuids, (n) => n + 1).pipe(
        Effect.map((n) => `0000000000000000-${n}`),
      ),
    });

    return { handlers, links, recorder } as const;
  });

const testLayer = Layer.mergeAll(
  WorkjetCrossModeLinkStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);

// ===============================
// Delegate to Code / Open in Code
// ===============================

it.effect("creates a Code thread, stores the link, and writes the durable backlink", () =>
  Effect.gen(function* () {
    const { handlers, recorder } = yield* harness();

    const result = yield* handlers.openInCode({
      ctox: ctoxRef(),
      presentation: PRESENTATION,
      hostThreadId: HOST_THREAD,
      context: CONTEXT,
    });

    assert.equal(result.selection, "created");
    assert.equal(result.link.code.threadId, "thread-1");
    // The Code authority is this server's, not anything the caller could name.
    assert.equal(result.link.code.environmentId, ENVIRONMENT);
    assert.deepEqual(result.link.ctox, ctoxRef());

    const state = yield* Ref.get(recorder);
    assert.equal(state.created.length, 1);
    assert.equal(state.created[0]?.title, PRESENTATION.title);
    // The scoped context is the seed, and it names the references rather than
    // reproducing a record.
    assert.include(state.created[0]?.seedMessage ?? "", CONTEXT.brief);
    assert.include(state.created[0]?.seedMessage ?? "", "deal_4711");

    assert.equal(state.activities.length, 1);
    assert.equal(state.activities[0]?.kind, WORKJET_CROSS_MODE_LINKED_ACTIVITY_KIND);
    assert.equal(state.activities[0]?.threadId, "thread-1");
    assert.equal(state.activities[0]?.payload.direction, "to-code");
    assert.equal(state.activities[0]?.payload.linkId, result.link.linkId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("SELECTS the existing thread on a second delegation instead of duplicating it", () =>
  Effect.gen(function* () {
    const { handlers, recorder } = yield* harness();
    const input = {
      ctox: ctoxRef(),
      presentation: PRESENTATION,
      hostThreadId: HOST_THREAD,
      context: CONTEXT,
    } as const;

    const first = yield* handlers.openInCode(input);
    const second = yield* handlers.openInCode(input);

    assert.equal(first.selection, "created");
    assert.equal(second.selection, "selected");
    assert.equal(second.link.linkId, first.link.linkId);
    assert.equal(second.link.code.threadId, first.link.code.threadId);

    // Exactly one thread was ever created, and nothing had to be cleaned up.
    const state = yield* Ref.get(recorder);
    assert.equal(state.created.length, 1);
    assert.deepEqual([...state.deleted], []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a renderer-invented CTOX authority and creates nothing", () =>
  Effect.gen(function* () {
    const { handlers, recorder, links } = yield* harness();

    const refused = yield* handlers
      .openInCode({
        ctox: ctoxRef({ instanceId: INVENTED_INSTANCE }),
        presentation: PRESENTATION,
        hostThreadId: HOST_THREAD,
        context: CONTEXT,
      })
      .pipe(Effect.result);

    assert.isTrue(refused._tag === "Failure");
    if (refused._tag !== "Failure") return;
    assert.equal(refused.failure.reason, "unverified-authority");

    // The refusal happens BEFORE any durable effect: no thread, no link.
    const state = yield* Ref.get(recorder);
    assert.deepEqual([...state.created], []);
    assert.deepEqual([...(yield* links.list(100))], []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses every operation when no CTOX authority is verifiable at all", () =>
  Effect.gen(function* () {
    const { handlers } = yield* harness({ ctox: workjetCrossModeCtoxPortUnavailable });

    const refused = yield* handlers
      .openInCode({
        ctox: ctoxRef(),
        presentation: PRESENTATION,
        hostThreadId: HOST_THREAD,
        context: CONTEXT,
      })
      .pipe(Effect.result);

    assert.isTrue(refused._tag === "Failure");
    if (refused._tag !== "Failure") return;
    assert.equal(refused.failure.reason, "unverified-authority");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a host thread that is not a live orchestrator thread", () =>
  Effect.gen(function* () {
    const nonOrchestrator = yield* harness({ hostRole: "standard" });
    const refusedRole = yield* nonOrchestrator.handlers
      .openInCode({
        ctox: ctoxRef(),
        presentation: PRESENTATION,
        hostThreadId: HOST_THREAD,
        context: CONTEXT,
      })
      .pipe(Effect.result);
    assert.isTrue(refusedRole._tag === "Failure");
    if (refusedRole._tag !== "Failure") return;
    assert.equal(refusedRole.failure.reason, "unauthorized");

    const deleted = yield* harness({ hostDeleted: true });
    const refusedDeleted = yield* deleted.handlers
      .openInCode({
        ctox: ctoxRef(),
        presentation: PRESENTATION,
        hostThreadId: HOST_THREAD,
        context: CONTEXT,
      })
      .pipe(Effect.result);
    assert.isTrue(refusedDeleted._tag === "Failure");
    if (refusedDeleted._tag !== "Failure") return;
    assert.equal(refusedDeleted.failure.reason, "unauthorized");
  }).pipe(Effect.provide(testLayer)),
);

// ===============================
// Reads
// ===============================

it.effect("answers the Code-side backlink read, and answers absence without an error", () =>
  Effect.gen(function* () {
    const { handlers } = yield* harness();
    const created = yield* handlers.openInCode({
      ctox: ctoxRef(),
      presentation: PRESENTATION,
      hostThreadId: HOST_THREAD,
      context: CONTEXT,
    });

    const linked = yield* handlers.getThreadLink({ threadId: ThreadId.make("thread-1") });
    assert.equal(linked.link?.linkId, created.link.linkId);

    const unlinked = yield* handlers.getThreadLink({ threadId: ThreadId.make("thread-2") });
    assert.isUndefined(unlinked.link);

    const listed = yield* handlers.listLinks({});
    assert.equal(listed.links.length, 1);
  }).pipe(Effect.provide(testLayer)),
);

// ===============================
// Return to Business OS
// ===============================

const openLink = (nowIso?: string) =>
  Effect.gen(function* () {
    const built = yield* harness(nowIso !== undefined ? { nowIso } : {});
    const created = yield* built.handlers.openInCode({
      ctox: ctoxRef(),
      presentation: PRESENTATION,
      hostThreadId: HOST_THREAD,
      context: CONTEXT,
    });
    return { ...built, link: created.link } as const;
  });

it.effect("routes each reverse operation to the CTOX command port with the STORED references", () =>
  Effect.gen(function* () {
    const { handlers, link, recorder } = yield* openLink();

    for (const operation of ["submit-result", "request-review", "follow-up"] as const) {
      const result = yield* handlers.submit({
        linkId: link.linkId,
        threadId: link.code.threadId,
        operation,
        evidence: EVIDENCE,
        ...(operation === "submit-result" ? { outcome: "completed" as const } : {}),
      });
      assert.equal(result.status, "dispatched");
      assert.equal(result.approval, "not-required");
      assert.equal(result.operation, operation);
    }

    const state = yield* Ref.get(recorder);
    assert.equal(state.dispatched.length, 3);
    for (const command of state.dispatched) {
      // The counterpart address came from the stored link, never from a request.
      assert.equal(command.instanceId, INSTANCE);
      assert.equal(command.moduleId, MODULE);
      assert.equal(command.objectId, "deal_4711");
      assert.equal(command.linkId, link.linkId);
      assert.equal(command.codeEnvironmentId, ENVIRONMENT);
    }
    assert.equal(state.dispatched[0]?.outcome, "completed");
    assert.isUndefined(state.dispatched[1]?.outcome);

    // One `returned` activity per operation, on the linked thread.
    const returned = state.activities.filter(
      (entry) => entry.kind === WORKJET_CROSS_MODE_RETURNED_ACTIVITY_KIND,
    );
    assert.equal(returned.length, 3);
    assert.equal(returned[0]?.payload.direction, "to-business-os");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports the CTOX approval gate through the existing approval vocabulary", () =>
  Effect.gen(function* () {
    const built = yield* harness();
    const recorder = built.recorder;
    // Re-build the handlers with a port that proposes rather than executes.
    const gated = makeWorkjetCrossModeRpcHandlers({
      links: built.links,
      ctox: verifyingPort(recorder, { awaitingApproval: true }),
      threads: threadPort(recorder, ["thread-1"]),
      query: {
        getThreadDetailById: () => Effect.succeed(Option.some(thread({ threadId: HOST_THREAD }))),
      },
      environmentId: ENVIRONMENT,
      nowIso: Effect.succeed(NOW),
      randomUUID: Effect.succeed("0000000000000000-gated"),
    });

    const created = yield* gated.openInCode({
      ctox: ctoxRef(),
      presentation: PRESENTATION,
      hostThreadId: HOST_THREAD,
      context: CONTEXT,
    });

    const result = yield* gated.submit({
      linkId: created.link.linkId,
      threadId: created.link.code.threadId,
      operation: "request-review",
      evidence: EVIDENCE,
    });

    assert.equal(result.status, "awaiting-approval");
    assert.equal(result.approval, "pending");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a submission whose CTOX command surface is unavailable", () =>
  Effect.gen(function* () {
    const built = yield* harness();
    const created = yield* built.handlers.openInCode({
      ctox: ctoxRef(),
      presentation: PRESENTATION,
      hostThreadId: HOST_THREAD,
      context: CONTEXT,
    });

    // The link exists, but the boundary has since gone away: a well-formed,
    // authorized request that simply cannot land.
    const downstream = makeWorkjetCrossModeRpcHandlers({
      links: built.links,
      ctox: {
        verifyAuthority: () => Effect.succeed(true),
        dispatch: workjetCrossModeCtoxPortUnavailable.dispatch,
      },
      threads: threadPort(built.recorder, []),
      query: {
        getThreadDetailById: (threadId) =>
          Effect.succeed(Option.some(thread({ threadId, role: "standard" }))),
      },
      environmentId: ENVIRONMENT,
      nowIso: Effect.succeed(NOW),
      randomUUID: Effect.succeed("0000000000000000-x"),
    });

    const refused = yield* downstream
      .submit({
        linkId: created.link.linkId,
        threadId: created.link.code.threadId,
        operation: "submit-result",
        evidence: EVIDENCE,
        outcome: "completed",
      })
      .pipe(Effect.result);

    assert.isTrue(refused._tag === "Failure");
    if (refused._tag !== "Failure") return;
    assert.equal(refused.failure.reason, "ctox-command-unavailable");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a submission from a thread the link does not name", () =>
  Effect.gen(function* () {
    const { handlers, link } = yield* openLink();

    const refused = yield* handlers
      .submit({
        linkId: link.linkId,
        threadId: ThreadId.make("thread-2"),
        operation: "submit-result",
        evidence: EVIDENCE,
        outcome: "completed",
      })
      .pipe(Effect.result);

    assert.isTrue(refused._tag === "Failure");
    if (refused._tag !== "Failure") return;
    assert.equal(refused.failure.reason, "unknown-link");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses an unknown link id", () =>
  Effect.gen(function* () {
    const { handlers } = yield* harness();
    const refused = yield* handlers
      .submit({
        linkId: "wjx-0000000000-missing" as WorkjetCrossModeLinkId,
        threadId: ThreadId.make("thread-1"),
        operation: "follow-up",
        evidence: EVIDENCE,
      })
      .pipe(Effect.result);

    assert.isTrue(refused._tag === "Failure");
    if (refused._tag !== "Failure") return;
    assert.equal(refused.failure.reason, "unknown-link");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses to act on a link whose Code authority is another environment", () =>
  Effect.gen(function* () {
    const links = yield* WorkjetCrossModeLinkStore;
    const recorder = yield* Ref.make(EMPTY_RECORDER);

    // A row that names a DIFFERENT environment — a database carried between
    // machines cannot make this server act as another one.
    const foreign = {
      schemaVersion: 1 as const,
      linkId: "wjx-0000000000-foreign" as WorkjetCrossModeLinkId,
      ctox: ctoxRef(),
      code: {
        schemaVersion: 1 as const,
        environmentId: OTHER_ENVIRONMENT,
        threadId: ThreadId.make("thread-1"),
      },
      presentation: PRESENTATION,
      createdAt: NOW,
    };
    yield* links.createOrSelect(foreign);

    const handlers = makeWorkjetCrossModeRpcHandlers({
      links,
      ctox: verifyingPort(recorder),
      threads: threadPort(recorder, []),
      query: {
        getThreadDetailById: (threadId) =>
          Effect.succeed(Option.some(thread({ threadId, role: "standard" }))),
      },
      environmentId: ENVIRONMENT,
      nowIso: Effect.succeed(NOW),
      randomUUID: Effect.succeed("0000000000000000-y"),
    });

    const refused = yield* handlers
      .submit({
        linkId: foreign.linkId,
        threadId: foreign.code.threadId,
        operation: "submit-result",
        evidence: EVIDENCE,
        outcome: "completed",
      })
      .pipe(Effect.result);

    assert.isTrue(refused._tag === "Failure");
    if (refused._tag !== "Failure") return;
    assert.equal(refused.failure.reason, "unauthorized");
    assert.deepEqual([...(yield* Ref.get(recorder)).dispatched], []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("re-verifies the CTOX authority on every reverse operation, not just at link time", () =>
  Effect.gen(function* () {
    const built = yield* harness();
    const created = yield* built.handlers.openInCode({
      ctox: ctoxRef(),
      presentation: PRESENTATION,
      hostThreadId: HOST_THREAD,
      context: CONTEXT,
    });

    // The instance was verifiable when the link was made and is not any more.
    const revoked = makeWorkjetCrossModeRpcHandlers({
      links: built.links,
      ctox: {
        verifyAuthority: () => Effect.succeed(false),
        dispatch: () => Effect.die("unreachable"),
      },
      threads: threadPort(built.recorder, []),
      query: {
        getThreadDetailById: (threadId) =>
          Effect.succeed(Option.some(thread({ threadId, role: "standard" }))),
      },
      environmentId: ENVIRONMENT,
      nowIso: Effect.succeed(NOW),
      randomUUID: Effect.succeed("0000000000000000-z"),
    });

    const refused = yield* revoked
      .submit({
        linkId: created.link.linkId,
        threadId: created.link.code.threadId,
        operation: "submit-result",
        evidence: EVIDENCE,
        outcome: "completed",
      })
      .pipe(Effect.result);

    assert.isTrue(refused._tag === "Failure");
    if (refused._tag !== "Failure") return;
    assert.equal(refused.failure.reason, "unverified-authority");
  }).pipe(Effect.provide(testLayer)),
);

// ===============================
// The seeded context
// ===============================

it("seeds the linked thread with references and the operator brief, never a record", () => {
  const seed = composeCrossModeSeedMessage({
    link: { ctox: ctoxRef(), presentation: { ...PRESENTATION, subtitle: "Stage: negotiation" } },
    brief: CONTEXT.brief,
  });
  assert.include(seed, "ACME Q3 renewal");
  assert.include(seed, "Stage: negotiation");
  assert.include(seed, "crm/deal/deal_4711");
  assert.include(seed, CONTEXT.brief);
  // The whole message is bounded by its inputs; there is no record to include.
  assert.isBelow(seed.length, 4_096);
});
