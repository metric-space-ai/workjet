// @effect-diagnostics nodeBuiltinImport:off - the architectural invariants are proved by reading this directory's own source.
import {
  CtoxManagedInstanceHealth,
  EnvironmentId,
  ThreadId,
  WorkjetBusinessOsObjectId,
  WorkjetBusinessOsObjectKind,
  WorkjetCrossModeError,
  WorkjetCrossModeLinkId,
  WorkjetCrossModeOpenInCodeRpcInput,
  type CtoxAppModuleId,
  type CtoxManagedInstanceId,
  type OrchestrationThread,
  type WorkjetCrossModeActivityPayload,
  type WorkjetCrossModeCtoxRef,
  type WorkjetCrossModeEvidence,
  type WorkjetCrossModeLink,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  WorkjetCrossModeLinkStore,
  WorkjetCrossModeLinkStoreLive,
  type WorkjetCrossModeLinkStoreShape,
} from "./WorkjetCrossModeLinkStore.ts";
import {
  workjetCrossModeCtoxPortUnavailable,
  type WorkjetCrossModeCtoxCommand,
  type WorkjetCrossModeCtoxPortShape,
} from "./WorkjetCrossModeCtoxPort.ts";
import {
  makeWorkjetCrossModeRpcHandlers,
  WORKJET_CROSS_MODE_RETURNED_ACTIVITY_KIND,
  type WorkjetCrossModeRpcHandlers,
  type WorkjetCrossModeThreadPort,
} from "./WorkjetCrossModeRpc.ts";

/**
 * THE CROSS-MODE PROOF MATRIX (docs/workjet-plan.md → "Cross-mode workflow
 * bridge", last open item):
 *
 *   "Prove local, remote, offline, revoked-access, stale-link, and
 *    deleted-counterpart behaviour without a shared database or a Business OS
 *    HTTP data bridge."
 *
 * Every behaviour below is a TEST that fails if the behaviour regresses, not a
 * paragraph asserting it. The proofs are written against the CTOX port
 * INTERFACE with fakes, never against an implementation, so they hold for the
 * `Unavailable` implementation this slice ships AND for the real daemon port —
 * a port that changed the answers below would fail these tests.
 *
 * BEHAVIOUR → PROOF → BOUNDED REFUSAL REASON
 *
 * | # | behaviour            | test name (grep-able prefix)   | refusal reason            |
 * |---|----------------------|--------------------------------|---------------------------|
 * | 1 | local                | `proof 1/6 local`              | (none — succeeds)         |
 * | 2 | remote               | `proof 2/6 remote`             | `unauthorized`            |
 * | 3 | offline              | `proof 3/6 offline`            | `ctox-command-unavailable`|
 * | 4 | revoked-access       | `proof 4/6 revoked-access`     | `unverified-authority`    |
 * | 5 | stale-link           | `proof 5/6 stale-link`         | `link-expired`            |
 * | 6a| deleted Code thread  | `proof 6a/6 deleted-counterpart`| `unauthorized`           |
 * | 6b| deleted BOS object   | `proof 6b/6 deleted-counterpart`| `ctox-command-rejected`  |
 * | A | no shared database   | `invariant A no shared database`| n/a (structural)         |
 * | B | no HTTP data bridge  | `invariant B no http data bridge`| n/a (structural)        |
 *
 * DECISIONS THIS MODULE MAKES AND PROVES, rather than leaving to prose:
 *
 * - STALE LINKS STAY READABLE. An expired link refuses every OPERATION with
 *   `link-expired`, and both READS (`getThreadLink`, `listLinks`) still return
 *   it. A stale link is history: hiding it would make the operator's timebox
 *   look like the work never happened, which is a lie the store has the data to
 *   avoid telling.
 * - REVOCATION AND DELETION NEVER ERASE A LINK ROW. Every refusal proof below
 *   re-reads the store afterwards and asserts the row is byte-identical. A
 *   revoked instance and a deleted thread are both reasons to REFUSE, never
 *   reasons to forget.
 * - "COUNTERPART GONE" IS REPORTED AS `unauthorized`, not as a new reason. The
 *   contract documents `unauthorized` as covering "missing, deleted, or not
 *   permitted" and deliberately does not distinguish them on the wire; adding a
 *   distinct reason would both break that discipline and strand the renderer's
 *   closed reason set (`apps/web/.../WorkjetCrossModeLinkCard.tsx`).
 * - AN OBJECT'S EXISTENCE IS THE CTOX AUTHORITY'S ANSWER, NOT THIS SERVER'S.
 *   The port verifies an INSTANCE, not an object, because there is no shared
 *   database in which this server could look an object up. A Business OS object
 *   that vanished is therefore discovered at DISPATCH, as
 *   `ctox-command-rejected` — proof 6b asserts both halves of that boundary,
 *   including the honest limitation that a link to an already-vanished object
 *   can still be created locally.
 */

// ===============================
// Fixtures
// ===============================

const ENVIRONMENT = EnvironmentId.make("environment-local");
const OTHER_ENVIRONMENT = EnvironmentId.make("environment-remote");
const INSTANCE: CtoxManagedInstanceId = "paired:manual_pairing:office-1";
const MODULE = "crm" as CtoxAppModuleId;
const HOST_THREAD = ThreadId.make("thread-host");
const LINKED_THREAD = ThreadId.make("thread-1");
const NOW = "2026-08-19T10:00:00.000Z";
const ALREADY_PAST = "2026-08-18T10:00:00.000Z";

const ctoxRef = (objectId = "deal_4711"): WorkjetCrossModeCtoxRef => ({
  schemaVersion: 1,
  instanceId: INSTANCE,
  moduleId: MODULE,
  objectKind: WorkjetBusinessOsObjectKind.make("deal"),
  objectId: WorkjetBusinessOsObjectId.make(objectId),
});

const PRESENTATION = { schemaVersion: 1, title: "ACME Q3 renewal" } as const;
const CONTEXT = { schemaVersion: 1, brief: "Implement the renewal discount rule." } as const;
const EVIDENCE: WorkjetCrossModeEvidence = {
  schemaVersion: 1,
  summary: "Renewal terms implemented and tested.",
  artifacts: { schemaVersion: 1, commitHashes: [], paths: [] },
};

const openInCodeInput = (objectId?: string) =>
  ({
    ctox: ctoxRef(objectId),
    presentation: PRESENTATION,
    hostThreadId: HOST_THREAD,
    context: CONTEXT,
  }) as const;

const submitInput = (linkId: WorkjetCrossModeLinkId, threadId: ThreadId) =>
  ({
    linkId,
    threadId,
    operation: "submit-result",
    evidence: EVIDENCE,
    outcome: "completed",
  }) as const;

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
  readonly created: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<ThreadId>;
  readonly activities: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly payload: WorkjetCrossModeActivityPayload;
  }>;
  readonly dispatched: ReadonlyArray<WorkjetCrossModeCtoxCommand>;
  readonly verified: ReadonlyArray<CtoxManagedInstanceId>;
}

const EMPTY_RECORDER: Recorder = {
  created: [],
  deleted: [],
  activities: [],
  dispatched: [],
  verified: [],
};

const failureReason = (
  result: { readonly _tag: "Success" } | { readonly _tag: "Failure"; readonly failure: unknown },
): string => {
  assert.equal(result._tag, "Failure", "expected a bounded refusal, got a success");
  if (result._tag !== "Failure") return "";
  const failure = result.failure;
  assert.instanceOf(failure, WorkjetCrossModeError);
  return (failure as WorkjetCrossModeError).reason;
};

// ===============================
// Ports (fakes against the INTERFACE, never an implementation)
// ===============================

/** The LOCAL daemon: it vouches for this machine's instance and executes. */
const localDaemonPort = (recorder: Ref.Ref<Recorder>): WorkjetCrossModeCtoxPortShape => ({
  verifyAuthority: (instanceId) =>
    Ref.update(recorder, (current) => ({
      ...current,
      verified: [...current.verified, instanceId],
    })).pipe(Effect.as(instanceId === INSTANCE)),
  dispatch: (command) =>
    Ref.update(recorder, (current) => ({
      ...current,
      dispatched: [...current.dispatched, command],
    })).pipe(Effect.as({ _tag: "dispatched" } as const)),
});

/**
 * OFFLINE: the daemon cannot be reached at all. Note that this is NOT
 * `verifyAuthority: () => succeed(false)` — an unreachable boundary is not the
 * same claim as "that instance is not mine", and the contract has a separate
 * bounded reason for each.
 */
const offlinePort: WorkjetCrossModeCtoxPortShape = {
  verifyAuthority: () =>
    Effect.fail(new WorkjetCrossModeError({ reason: "ctox-command-unavailable" })),
  dispatch: workjetCrossModeCtoxPortUnavailable.dispatch,
};

/** REVOKED: the instance is reachable and refuses to vouch for itself any more. */
const revokedPort: WorkjetCrossModeCtoxPortShape = {
  verifyAuthority: () => Effect.succeed(false),
  dispatch: () => Effect.die("a revoked authority must never be dispatched to"),
};

/** The instance is fine; the OBJECT the command names is not there any more. */
const objectGonePort: WorkjetCrossModeCtoxPortShape = {
  verifyAuthority: () => Effect.succeed(true),
  dispatch: () => Effect.fail(new WorkjetCrossModeError({ reason: "ctox-command-rejected" })),
};

const threadPort = (
  recorder: Ref.Ref<Recorder>,
  nextThreadIds: ReadonlyArray<string>,
): WorkjetCrossModeThreadPort => {
  const queue = [...nextThreadIds];
  return {
    createLinkedThread: (input) =>
      Ref.update(recorder, (current) => ({
        ...current,
        created: [...current.created, input.title],
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

interface Harness {
  readonly handlers: WorkjetCrossModeRpcHandlers;
  readonly links: WorkjetCrossModeLinkStoreShape;
  readonly recorder: Ref.Ref<Recorder>;
}

/**
 * Builds handlers over a REAL migration-052 store (in memory) and injected
 * ports. `deletedThreads` is what makes the deleted-counterpart proof possible:
 * a thread that the projection reports with a `deletedAt`.
 */
const harness = (
  options: {
    readonly ctox?: WorkjetCrossModeCtoxPortShape;
    readonly links?: WorkjetCrossModeLinkStoreShape;
    readonly recorder?: Ref.Ref<Recorder>;
    readonly nextThreads?: ReadonlyArray<string>;
    /** Keeps link ids distinct when two harnesses share one store. */
    readonly idSeed?: string;
    readonly deletedThreads?: ReadonlyArray<string>;
    readonly environmentId?: EnvironmentId;
  } = {},
): Effect.Effect<Harness, never, WorkjetCrossModeLinkStore> =>
  Effect.gen(function* () {
    const links = options.links ?? (yield* WorkjetCrossModeLinkStore);
    const recorder = options.recorder ?? (yield* Ref.make(EMPTY_RECORDER));
    const uuids = yield* Ref.make(0);
    const deleted = new Set(options.deletedThreads ?? []);

    const handlers = makeWorkjetCrossModeRpcHandlers({
      links,
      ctox: options.ctox ?? localDaemonPort(recorder),
      threads: threadPort(recorder, options.nextThreads ?? ["thread-1", "thread-2"]),
      query: {
        getThreadDetailById: (threadId) =>
          Effect.succeed(
            Option.some(
              thread({
                threadId,
                role: threadId === HOST_THREAD ? "orchestrator" : "standard",
                deleted: deleted.has(threadId),
              }),
            ),
          ),
      },
      environmentId: options.environmentId ?? ENVIRONMENT,
      nowIso: Effect.succeed(NOW),
      randomUUID: Ref.updateAndGet(uuids, (n) => n + 1).pipe(
        Effect.map((n) => `000000000000000${options.idSeed ?? "0"}-${n}`),
      ),
    });

    return { handlers, links, recorder };
  });

const testLayer = Layer.mergeAll(
  WorkjetCrossModeLinkStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);

/** The whole durable surface, as one comparable value. */
const storeSnapshot = (links: WorkjetCrossModeLinkStoreShape) =>
  links.list(100).pipe(Effect.map((records) => JSON.stringify(records)));

// ===============================
// 1. LOCAL
// ===============================

it.effect(
  "cross-mode proof 1/6 local: the full round trip works and the SELECT branch reuses the thread",
  () =>
    Effect.gen(function* () {
      const { handlers, links, recorder } = yield* harness();

      // Create-or-select, first click: CREATE.
      const created = yield* handlers.openInCode(openInCodeInput());
      assert.equal(created.selection, "created");
      assert.equal(created.link.code.threadId, LINKED_THREAD);
      // The Code authority is THIS environment, filled in server-side.
      assert.equal(created.link.code.environmentId, ENVIRONMENT);
      assert.equal(created.link.ctox.instanceId, INSTANCE);

      // The return operation lands on the local daemon with the STORED address.
      const returned = yield* handlers.submit(submitInput(created.link.linkId, LINKED_THREAD));
      assert.equal(returned.status, "dispatched");
      assert.equal(returned.approval, "not-required");

      // Create-or-select, second click: SELECT — the same thread, not a second one.
      const selected = yield* handlers.openInCode(openInCodeInput());
      assert.equal(selected.selection, "selected");
      assert.equal(selected.link.linkId, created.link.linkId);
      assert.equal(selected.link.code.threadId, created.link.code.threadId);

      const state = yield* Ref.get(recorder);
      assert.equal(state.created.length, 1, "the SELECT branch must not create a second thread");
      assert.deepEqual([...state.deleted], []);
      assert.equal(state.dispatched.length, 1);
      assert.equal(state.dispatched[0]?.instanceId, INSTANCE);
      assert.equal(state.dispatched[0]?.objectId, "deal_4711");
      assert.equal(state.dispatched[0]?.codeEnvironmentId, ENVIRONMENT);
      // One durable link, however many times the button is pressed.
      assert.equal((yield* links.list(100)).length, 1);
    }).pipe(Effect.provide(testLayer)),
);

// ===============================
// 2. REMOTE
// ===============================

/**
 * A delegation request that TRIES to name another Code authority, decoded
 * through the real contract. The decode is hoisted out of the Effect generator
 * because it is a structural fact about the schema, not a step of the scenario.
 */
const DELEGATION_INPUT_WITH_A_FOREIGN_ENVIRONMENT = Schema.decodeUnknownSync(
  WorkjetCrossModeOpenInCodeRpcInput,
)({
  ...openInCodeInput(),
  environmentId: OTHER_ENVIRONMENT,
});

it.effect(
  "cross-mode proof 2/6 remote: another environment's link is refused (unauthorized) and never dispatched",
  () =>
    Effect.gen(function* () {
      // (a) STRUCTURAL. The delegation input has no `environmentId` at all, so a
      // renderer cannot even ask this server to act as another environment.
      assert.notProperty(DELEGATION_INPUT_WITH_A_FOREIGN_ENVIRONMENT, "environmentId");

      // (b) THE STORED-LINK PATH. A row naming a different Code authority — a
      // database file carried between machines — must not make this server act.
      const links = yield* WorkjetCrossModeLinkStore;
      const foreign: WorkjetCrossModeLink = {
        schemaVersion: 1,
        linkId: WorkjetCrossModeLinkId.make("wjx-0000000000-foreign"),
        ctox: ctoxRef(),
        code: { schemaVersion: 1, environmentId: OTHER_ENVIRONMENT, threadId: LINKED_THREAD },
        presentation: PRESENTATION,
        createdAt: NOW,
      };
      yield* links.createOrSelect(foreign);
      const before = yield* storeSnapshot(links);

      const { handlers, recorder } = yield* harness({ links });
      const refused = yield* handlers
        .submit(submitInput(foreign.linkId, LINKED_THREAD))
        .pipe(Effect.result);

      assert.equal(failureReason(refused), "unauthorized");

      const state = yield* Ref.get(recorder);
      assert.deepEqual([...state.dispatched], [], "a foreign link must never reach the CTOX port");
      assert.deepEqual([...state.activities], []);
      // The foreign row is refused, not rewritten and not deleted.
      assert.equal(yield* storeSnapshot(links), before);
    }).pipe(Effect.provide(testLayer)),
);

// ===============================
// 3. OFFLINE
// ===============================

it.effect(
  "cross-mode proof 3/6 offline: operations refuse (ctox-command-unavailable), reads still answer, and nothing durable is written",
  () =>
    Effect.gen(function* () {
      // A link that already exists from when the daemon was up.
      const online = yield* harness();
      const created = yield* online.handlers.openInCode(openInCodeInput());
      const before = yield* storeSnapshot(online.links);

      const offline = yield* harness({ ctox: offlinePort, links: online.links });

      // Forward direction: refuses before a thread is created.
      const refusedOpen = yield* offline.handlers
        .openInCode(openInCodeInput("deal_9999"))
        .pipe(Effect.result);
      assert.equal(failureReason(refusedOpen), "ctox-command-unavailable");

      // Reverse direction: refuses before any durable effect.
      const refusedSubmit = yield* offline.handlers
        .submit(submitInput(created.link.linkId, LINKED_THREAD))
        .pipe(Effect.result);
      assert.equal(failureReason(refusedSubmit), "ctox-command-unavailable");

      const state = yield* Ref.get(offline.recorder);
      assert.deepEqual(
        [...state.created],
        [],
        "an offline daemon must not cost this machine a thread",
      );
      assert.deepEqual([...state.activities], []);
      assert.deepEqual([...state.dispatched], []);
      // THE STORE IS UNCHANGED — the whole point of proving "nothing durable".
      assert.equal(yield* storeSnapshot(online.links), before);

      // Reads are LOCAL and keep working while the counterpart is unreachable.
      // This is the no-shared-database property seen from the operator's side.
      const link = yield* offline.handlers.getThreadLink({ threadId: LINKED_THREAD });
      assert.equal(link.link?.linkId, created.link.linkId);
      const listed = yield* offline.handlers.listLinks({});
      assert.equal(listed.links.length, 1);
    }).pipe(Effect.provide(testLayer)),
);

// ===============================
// 4. REVOKED ACCESS
// ===============================

it.effect(
  "cross-mode proof 4/6 revoked-access: a later operation refuses (unverified-authority) before any effect and the link row survives",
  () =>
    Effect.gen(function* () {
      // Verifiable at link time.
      const online = yield* harness();
      const created = yield* online.handlers.openInCode(openInCodeInput());
      const before = yield* storeSnapshot(online.links);
      assert.include(before, created.link.linkId);

      // Refused later. `revokedPort.dispatch` DIES if reached, so this also
      // proves the ordering: verification happens BEFORE the command.
      const revoked = yield* harness({ ctox: revokedPort, links: online.links });

      const refusedSubmit = yield* revoked.handlers
        .submit(submitInput(created.link.linkId, LINKED_THREAD))
        .pipe(Effect.result);
      assert.equal(failureReason(refusedSubmit), "unverified-authority");

      const refusedOpen = yield* revoked.handlers.openInCode(openInCodeInput()).pipe(Effect.result);
      assert.equal(failureReason(refusedOpen), "unverified-authority");

      const state = yield* Ref.get(revoked.recorder);
      assert.deepEqual([...state.activities], []);
      assert.deepEqual([...state.created], []);
      // REVOCATION IS NOT DELETION. The history of the link survives it.
      assert.equal(yield* storeSnapshot(online.links), before);
      const stillThere = yield* online.links.getById(created.link.linkId);
      assert.isTrue(Option.isSome(stillThere));
    }).pipe(Effect.provide(testLayer)),
);

// ===============================
// 5. STALE LINK
// ===============================

it.effect(
  "cross-mode proof 5/6 stale-link: operations refuse (link-expired) while both reads still show the link",
  () =>
    Effect.gen(function* () {
      const links = yield* WorkjetCrossModeLinkStore;
      const stale: WorkjetCrossModeLink = {
        schemaVersion: 1,
        linkId: WorkjetCrossModeLinkId.make("wjx-0000000000-stale"),
        ctox: ctoxRef(),
        code: { schemaVersion: 1, environmentId: ENVIRONMENT, threadId: LINKED_THREAD },
        presentation: PRESENTATION,
        createdAt: ALREADY_PAST,
        expiresAt: ALREADY_PAST,
      };
      yield* links.createOrSelect(stale);
      const before = yield* storeSnapshot(links);

      const { handlers, recorder } = yield* harness({ links });

      // Reverse direction refuses.
      const refusedSubmit = yield* handlers
        .submit(submitInput(stale.linkId, LINKED_THREAD))
        .pipe(Effect.result);
      assert.equal(failureReason(refusedSubmit), "link-expired");

      // Forward direction refuses rather than silently re-linking the object:
      // re-linking would discard the operator's deliberate timebox.
      const refusedOpen = yield* handlers.openInCode(openInCodeInput()).pipe(Effect.result);
      assert.equal(failureReason(refusedOpen), "link-expired");

      // READS STILL SHOW IT. The decision this module makes: a stale link is
      // history, not a lie, and both read paths keep answering with it.
      const backlink = yield* handlers.getThreadLink({ threadId: LINKED_THREAD });
      assert.equal(backlink.link?.linkId, stale.linkId);
      assert.equal(backlink.link?.expiresAt, ALREADY_PAST);
      const listed = yield* handlers.listLinks({});
      assert.deepEqual(
        listed.links.map((entry) => entry.linkId),
        [stale.linkId],
      );

      const state = yield* Ref.get(recorder);
      assert.deepEqual([...state.dispatched], []);
      assert.deepEqual([...state.created], []);
      assert.equal(yield* storeSnapshot(links), before);
    }).pipe(Effect.provide(testLayer)),
);

// ===============================
// 6a. DELETED COUNTERPART — the Code thread
// ===============================

it.effect(
  "cross-mode proof 6a/6 deleted-counterpart (Code thread): operations refuse (unauthorized) and the link row survives",
  () =>
    Effect.gen(function* () {
      const online = yield* harness();
      const created = yield* online.handlers.openInCode(openInCodeInput());
      const before = yield* storeSnapshot(online.links);

      // The Code thread the link names has since been deleted.
      const gone = yield* harness({
        links: online.links,
        deletedThreads: [LINKED_THREAD],
      });

      // Reverse direction: a deleted thread may not act.
      const refusedSubmit = yield* gone.handlers
        .submit(submitInput(created.link.linkId, LINKED_THREAD))
        .pipe(Effect.result);
      assert.equal(failureReason(refusedSubmit), "unauthorized");

      // Forward direction: "Open in Code" must not hand back a link to a thread
      // nobody can open. (See the production note in `WorkjetCrossModeRpc`.)
      const refusedOpen = yield* gone.handlers.openInCode(openInCodeInput()).pipe(Effect.result);
      assert.equal(failureReason(refusedOpen), "unauthorized");

      const state = yield* Ref.get(gone.recorder);
      assert.deepEqual([...state.dispatched], []);
      assert.deepEqual([...state.activities], []);
      assert.deepEqual(
        [...state.created],
        [],
        "a deleted counterpart must not silently fork a replacement thread",
      );

      // THE LINK IS HISTORY, NOT GARBAGE. It survives the deletion untouched and
      // the bounded listing still reports it.
      assert.equal(yield* storeSnapshot(online.links), before);
      const listed = yield* gone.handlers.listLinks({});
      assert.deepEqual(
        listed.links.map((entry) => entry.linkId),
        [created.link.linkId],
      );
    }).pipe(Effect.provide(testLayer)),
);

// ===============================
// 6b. DELETED COUNTERPART — the Business OS object
// ===============================

it.effect(
  "cross-mode proof 6b/6 deleted-counterpart (Business OS object): the CTOX authority refuses (ctox-command-rejected) and nothing durable changes",
  () =>
    Effect.gen(function* () {
      const online = yield* harness();
      const created = yield* online.handlers.openInCode(openInCodeInput());
      const before = yield* storeSnapshot(online.links);

      // The instance is healthy; the OBJECT is gone, so the counterpart refuses
      // the command. This server cannot pre-empt that answer — there is no shared
      // database in which it could look the object up — so it reports the
      // authority's refusal without reinterpreting it.
      const vanished = yield* harness({ ctox: objectGonePort, links: online.links });
      const refused = yield* vanished.handlers
        .submit(submitInput(created.link.linkId, LINKED_THREAD))
        .pipe(Effect.result);
      assert.equal(failureReason(refused), "ctox-command-rejected");

      // NOTHING DURABLE. A rejected command writes no `returned` activity — the
      // trace must not claim a return that the authority refused.
      const state = yield* Ref.get(vanished.recorder);
      assert.deepEqual(
        state.activities.filter(
          (entry) => entry.kind === WORKJET_CROSS_MODE_RETURNED_ACTIVITY_KIND,
        ),
        [],
      );
      assert.equal(yield* storeSnapshot(online.links), before);

      // THE HONEST LIMITATION, proved rather than hidden: a link to an object
      // that is ALREADY gone can still be created, because instance verification
      // is the only pre-flight this boundary has. Every return from it then
      // refuses, so the mistake is bounded and visible instead of silent.
      const fresh = yield* harness({
        ctox: objectGonePort,
        links: online.links,
        nextThreads: ["thread-2"],
        idSeed: "b",
      });
      const linkedToNothing = yield* fresh.handlers.openInCode(openInCodeInput("deal_deleted"));
      assert.equal(linkedToNothing.selection, "created");
      const refusedFresh = yield* fresh.handlers
        .submit(submitInput(linkedToNothing.link.linkId, linkedToNothing.link.code.threadId))
        .pipe(Effect.result);
      assert.equal(failureReason(refusedFresh), "ctox-command-rejected");
    }).pipe(Effect.provide(testLayer)),
);

// ===============================
// Invariant A — no shared database
// ===============================

const CROSS_MODE_DIR = import.meta.dirname;

const sourceFiles = (): ReadonlyArray<{ readonly name: string; readonly body: string }> =>
  NodeFS.readdirSync(CROSS_MODE_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({
      name,
      body: NodeFS.readFileSync(NodePath.join(CROSS_MODE_DIR, name), "utf8"),
    }));

/**
 * Comments are stripped before scanning: this module's own prose (and the port's)
 * legitimately discusses HTTP and CTOX tables while the CODE must contain
 * neither, and a scan that could not tell them apart would be unfalsifiable.
 */
const withoutComments = (body: string): string =>
  body.replaceAll(/\/\*[\s\S]*?\*\//g, " ").replaceAll(/(^|\s)\/\/[^\n]*/g, " ");

it("cross-mode invariant A no shared database: the only CTOX contact is the port interface", () => {
  const files = sourceFiles();
  assert.isAtLeast(files.length, 4, "the crossmode module should not have vanished");

  // 1. The port interface is exactly two methods. A caller that could read CTOX
  //    state through a third one would have an unaudited window into it.
  assert.deepEqual(Object.keys(workjetCrossModeCtoxPortUnavailable).sort(), [
    "dispatch",
    "verifyAuthority",
  ]);

  // 2. No module in this directory imports a CTOX runtime. The ONLY CTOX-named
  //    import allowed anywhere in the cross-mode server path is the port itself.
  for (const file of files) {
    const imports = [...withoutComments(file.body).matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    for (const specifier of imports) {
      if (!/ctox/i.test(specifier)) continue;
      assert.equal(
        specifier,
        "./WorkjetCrossModeCtoxPort.ts",
        `${file.name} reaches CTOX through ${specifier} instead of the port`,
      );
    }
  }

  // 3. No SQL in this directory names any table but the LOCAL link table. A
  //    shared database would show up here as a `FROM ctox_…` first.
  for (const file of files) {
    const tables = [
      ...withoutComments(file.body).matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([A-Za-z_][\w]*)/g),
    ].map((match) => match[1]);
    for (const table of tables) {
      assert.equal(
        table,
        "workjet_cross_mode_links",
        `${file.name} reads or writes ${table}, which is not this server's own link table`,
      );
    }
  }
});

it.effect(
  "cross-mode invariant A no shared database: the round trip needs no CTOX table in this database",
  () =>
    Effect.gen(function* () {
      const { handlers } = yield* harness();
      const created = yield* handlers.openInCode(openInCodeInput());
      yield* handlers.submit(submitInput(created.link.linkId, LINKED_THREAD));

      // The full local round trip just succeeded against a database whose schema
      // contains no CTOX-owned table at all.
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
      const names = rows.map((row) => row.name);
      assert.include(names, "workjet_cross_mode_links");
      for (const name of names) {
        assert.notMatch(
          name,
          /^ctox_|_ctox_|business_os/i,
          `${name} looks like a CTOX-owned table inside this server's database`,
        );
      }
    }).pipe(Effect.provide(testLayer)),
);

// ===============================
// Invariant B — no Business OS HTTP data bridge
// ===============================

it("cross-mode invariant B no http data bridge: the guard holds and the cross-mode path adds no data route", () => {
  // 1. THE EXISTING GUARD. `CtoxManagedInstanceHealth.httpDataProxy` is a literal
  //    `false`, so "we turned the HTTP data proxy on" is not a representable
  //    state — no cross-mode change can set it true.
  const decodeHealth = Schema.decodeUnknownSync(CtoxManagedInstanceHealth);
  assert.deepEqual(
    decodeHealth({
      dataPlane: "rxdb-webrtc",
      dataPlaneReady: true,
      httpDataProxy: false,
      nativePeerObserved: true,
    }).httpDataProxy,
    false,
  );
  assert.throws(() =>
    decodeHealth({
      dataPlane: "rxdb-webrtc",
      dataPlaneReady: true,
      httpDataProxy: true,
      nativePeerObserved: true,
    }),
  );

  // 2. NO SECOND DATA ROUTE. The cross-mode server path opens no socket and
  //    speaks no URL of its own; the only egress it has is the port interface.
  const forbidden = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /HttpClient/,
    /\baxios\b/,
    /\bundici\b/,
    /node:https?/,
    /new\s+WebSocket/,
    /wss?:\/\//,
    /https?:\/\//,
  ];
  for (const file of sourceFiles()) {
    const code = withoutComments(file.body);
    for (const pattern of forbidden) {
      assert.notMatch(code, pattern, `${file.name} introduces a second data route (${pattern})`);
    }
  }
});
