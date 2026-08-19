// @effect-diagnostics preferSchemaOverJson:off -- redaction assertions inspect complete bounded activity payloads.
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WorkjetContentDigest,
  WorkjetMeshWorkspaceId,
  WorkjetRepositoryPath,
  WorkjetSealedPayloadRef,
  type OrchestrationCommand,
  type OrchestrationThread,
  type WorkjetMessageBody,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  makeWorkjetMailboxDeliveryWithSources,
  WORKJET_DELEGATION_RECEIVED_ACTIVITY_KIND,
  WORKJET_DELEGATION_SENT_ACTIVITY_KIND,
  WORKJET_MESSAGE_RECEIVED_ACTIVITY_KIND,
  WORKJET_MESSAGE_SENT_ACTIVITY_KIND,
  type WorkjetMailboxDelegateInput,
  type WorkjetMailboxDeliverySources,
  type WorkjetMailboxSendMessageInput,
} from "./WorkjetMailboxDelivery.ts";
import { WorkjetMailboxStore, WorkjetMailboxStoreLive } from "./WorkjetMailboxStore.ts";

const WORKSPACE = WorkjetMeshWorkspaceId.make("workjet-mesh-room-1");
const LOCAL_ENVIRONMENT = EnvironmentId.make("environment-local");
const REMOTE_ENVIRONMENT = EnvironmentId.make("environment-remote");
const SOURCE_THREAD = ThreadId.make("thread-source");
const TARGET_THREAD = ThreadId.make("thread-target");

const NOW = "2026-08-19T12:00:00.000Z";
const SECRET_TEXT = "MESSAGE_BODY_CANARY_MUST_NOT_LEAK";
const SECRET_PAYLOAD_REF = WorkjetSealedPayloadRef.make("c2VhbGVkLXBheWxvYWQtY2FuYXJ5");

const invocation: McpInvocationScope = {
  environmentId: LOCAL_ENVIRONMENT,
  threadId: SOURCE_THREAD,
  providerSessionId: "provider-session-mailbox",
  providerInstanceId: ProviderInstanceId.make("codex-main"),
  capabilities: new Set(["preview"]),
  workjetRole: "orchestrator",
  issuedAt: 1,
};

const targetThread = {
  id: TARGET_THREAD,
  deletedAt: null,
} as unknown as OrchestrationThread;

const deletedTargetThread = {
  id: TARGET_THREAD,
  deletedAt: NOW,
} as unknown as OrchestrationThread;

const nthId = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;

const inlineBody = { _tag: "inline", text: SECRET_TEXT } as const satisfies WorkjetMessageBody;
const sealedBody = {
  _tag: "sealed",
  payloadRef: SECRET_PAYLOAD_REF,
  byteLength: 2_048,
} as const satisfies WorkjetMessageBody;

const messageInput = (
  overrides?: Partial<WorkjetMailboxSendMessageInput>,
): WorkjetMailboxSendMessageInput => ({
  workspaceId: WORKSPACE,
  targetEnvironmentId: LOCAL_ENVIRONMENT,
  targetThreadId: TARGET_THREAD,
  body: inlineBody,
  ...overrides,
});

const delegateInput = (
  overrides?: Partial<WorkjetMailboxDelegateInput>,
): WorkjetMailboxDelegateInput => ({
  workspaceId: WORKSPACE,
  targetEnvironmentId: LOCAL_ENVIRONMENT,
  targetThreadId: TARGET_THREAD,
  prompt: {
    schemaVersion: 1,
    snapshotRef: WorkjetSealedPayloadRef.make("cHJvbXB0LXNuYXBzaG90LXJlZi0wMDE"),
    digest: WorkjetContentDigest.make("a".repeat(63) + "b"),
    byteLength: 4_096,
  },
  scope: {
    schemaVersion: 1,
    files: [
      WorkjetRepositoryPath.make("apps/server/src/workjet/mailbox/WorkjetMailboxDelivery.ts"),
    ],
    nonGoals: "No transport, no relay, no UI.",
  },
  completion: { schemaVersion: 1, acceptance: "Focused delivery tests pass." },
  budget: { maxDepth: 4, maxReviewRounds: 2, ttlSeconds: 7_200 },
  ...overrides,
});

/**
 * Every test builds its own in-memory database plus a recording engine, so the
 * durable rows and the thread-visible activities can be asserted exactly.
 */
const makeHarness = (input?: {
  readonly target?: OrchestrationThread | undefined;
  readonly failCommands?: boolean;
}) => {
  const commands: Array<OrchestrationCommand> = [];
  let idIndex = 0;
  const sources: WorkjetMailboxDeliverySources = {
    randomUUID: Effect.sync(() => nthId(idIndex++)),
    nowIso: Effect.succeed(NOW),
  };
  const engine = {
    dispatch: (command: OrchestrationCommand) => {
      commands.push(command);
      return input?.failCommands
        ? Effect.fail({ _tag: "DownstreamTestError", message: "downstream secret" } as const)
        : Effect.succeed({ sequence: commands.length });
    },
  } as unknown as OrchestrationEngineService["Service"];
  const query = {
    getThreadDetailById: () =>
      Effect.succeed(
        input && "target" in input
          ? input.target === undefined
            ? Option.none()
            : Option.some(input.target)
          : Option.some(targetThread),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"];

  const service = makeWorkjetMailboxDeliveryWithSources(sources).pipe(
    Effect.provideService(OrchestrationEngineService, engine),
    Effect.provideService(ProjectionSnapshotQuery, query),
  );
  return { commands, service };
};

const testLayer = Layer.mergeAll(
  WorkjetMailboxStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);

const activityKinds = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.activity.append" ? [command.activity.kind] : [],
  );

const activityFor = (commands: ReadonlyArray<OrchestrationCommand>, kind: string) =>
  commands.find(
    (command) => command.type === "thread.activity.append" && command.activity.kind === kind,
  );

// ===============================
// Messages
// ===============================

it.effect("delivers a same-environment message through the full outbox/inbox fast path", () =>
  Effect.gen(function* () {
    const { commands, service } = makeHarness();
    const delivery = yield* service;
    const store = yield* WorkjetMailboxStore;

    const outcome = yield* delivery.sendMessage(invocation, messageInput());

    assert.equal(outcome._tag, "acknowledged");
    if (outcome._tag !== "acknowledged") return;
    assert.equal(outcome.receipt.schemaVersion, 1);
    assert.equal(outcome.receipt.disposition, "accepted-new");
    assert.equal(outcome.receipt.acknowledgedAt, NOW);
    assert.deepEqual(outcome.receipt.acknowledgedBy, {
      schemaVersion: 1,
      workspaceId: WORKSPACE,
      environmentId: LOCAL_ENVIRONMENT,
      threadId: TARGET_THREAD,
    });

    // The local fast path obeys the same durable contract as remote delivery:
    // the outbox row is delivered and the inbox row exists exactly once.
    const outbound = yield* store.getOutbound(outcome.envelopeId);
    assert.isTrue(Option.isSome(outbound));
    assert.equal(Option.getOrThrow(outbound).state, "delivered");
    assert.equal(Option.getOrThrow(outbound).deliveredAtMillis, Date.parse(NOW));

    const inbound = yield* store.getInbound(outcome.envelopeId);
    assert.isTrue(Option.isSome(inbound));
    assert.equal(Option.getOrThrow(inbound).payload._tag, "message");

    assert.deepEqual(activityKinds(commands), [
      WORKJET_MESSAGE_SENT_ACTIVITY_KIND,
      WORKJET_MESSAGE_RECEIVED_ACTIVITY_KIND,
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("appends bounded redacted activities to both the source and the target thread", () =>
  Effect.gen(function* () {
    const { commands, service } = makeHarness();
    const delivery = yield* service;

    const outcome = yield* delivery.sendMessage(invocation, messageInput());

    const sent = activityFor(commands, WORKJET_MESSAGE_SENT_ACTIVITY_KIND);
    const received = activityFor(commands, WORKJET_MESSAGE_RECEIVED_ACTIVITY_KIND);
    assert.isDefined(sent);
    assert.isDefined(received);
    if (sent?.type !== "thread.activity.append" || received?.type !== "thread.activity.append") {
      return;
    }

    assert.equal(sent.threadId, SOURCE_THREAD);
    assert.equal(received.threadId, TARGET_THREAD);
    assert.equal(sent.activity.tone, "info");
    assert.deepEqual(sent.activity.payload, {
      schemaVersion: 1,
      envelopeId: outcome.envelopeId,
      direction: "outbound",
      source: {
        workspaceId: WORKSPACE,
        environmentId: LOCAL_ENVIRONMENT,
        threadId: SOURCE_THREAD,
      },
      target: {
        workspaceId: WORKSPACE,
        environmentId: LOCAL_ENVIRONMENT,
        threadId: TARGET_THREAD,
      },
      bodyKind: "inline",
      createdAt: NOW,
      expiresAt: "2026-08-19T13:00:00.000Z",
    });
    assert.deepEqual(received.activity.payload, {
      ...(sent.activity.payload as Record<string, unknown>),
      direction: "inbound",
      disposition: "accepted-new",
    });

    // The plan forbids prompt/body material in anything durable and readable.
    const serialized = JSON.stringify(commands);
    assert.isFalse(serialized.includes(SECRET_TEXT));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("treats a replayed envelope as a duplicate without a second inbound activity", () =>
  Effect.gen(function* () {
    const { commands, service } = makeHarness();
    const delivery = yield* service;
    const store = yield* WorkjetMailboxStore;

    const first = yield* delivery.sendMessage(invocation, messageInput());
    assert.equal(first._tag, "acknowledged");

    // The next envelope id is fresh, so a genuine replay is simulated by
    // re-recording the SAME envelope through the store's idempotent inbox.
    const outbound = Option.getOrThrow(yield* store.getOutbound(first.envelopeId));
    const replay = yield* store.recordInboundEnvelope(outbound.envelope, outbound.payload, NOW);
    assert.equal(replay._tag, "duplicate-ignored");

    // A second, distinct send still produces exactly one inbound activity each.
    const second = yield* delivery.sendMessage(invocation, messageInput());
    assert.notEqual(second.envelopeId, first.envelopeId);
    assert.deepEqual(activityKinds(commands), [
      WORKJET_MESSAGE_SENT_ACTIVITY_KIND,
      WORKJET_MESSAGE_RECEIVED_ACTIVITY_KIND,
      WORKJET_MESSAGE_SENT_ACTIVITY_KIND,
      WORKJET_MESSAGE_RECEIVED_ACTIVITY_KIND,
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("queues a cross-environment message as pending outbound without an inbox row", () =>
  Effect.gen(function* () {
    const { commands, service } = makeHarness();
    const delivery = yield* service;
    const store = yield* WorkjetMailboxStore;

    const outcome = yield* delivery.sendMessage(
      invocation,
      messageInput({ targetEnvironmentId: REMOTE_ENVIRONMENT, body: sealedBody }),
    );

    assert.equal(outcome._tag, "queued");
    const outbound = Option.getOrThrow(yield* store.getOutbound(outcome.envelopeId));
    assert.equal(outbound.state, "pending");
    assert.equal(outbound.envelope.targetEnvironmentId, REMOTE_ENVIRONMENT);
    assert.isTrue(Option.isNone(yield* store.getInbound(outcome.envelopeId)));

    const pending = yield* store.listPendingOutbound(NOW, 10);
    assert.equal(pending.length, 1);

    // Only the source thread can see it; the target thread lives elsewhere.
    assert.deepEqual(activityKinds(commands), [WORKJET_MESSAGE_SENT_ACTIVITY_KIND]);
    assert.isFalse(JSON.stringify(commands).includes(SECRET_PAYLOAD_REF));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses an inline body for a target in another environment", () =>
  Effect.gen(function* () {
    const { commands, service } = makeHarness();
    const delivery = yield* service;
    const store = yield* WorkjetMailboxStore;

    const error = yield* delivery
      .sendMessage(invocation, messageInput({ targetEnvironmentId: REMOTE_ENVIRONMENT }))
      .pipe(Effect.flip);

    assert.equal(error.reason, "malformed-envelope");
    assert.deepEqual(activityKinds(commands), []);
    assert.equal((yield* store.listOutboundByState("pending", 10)).length, 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects an unknown or deleted same-environment target before writing anything", () =>
  Effect.gen(function* () {
    const store = yield* WorkjetMailboxStore;

    const missing = makeHarness({ target: undefined });
    const unknownTarget = yield* (yield* missing.service)
      .sendMessage(invocation, messageInput())
      .pipe(Effect.flip);
    assert.equal(unknownTarget.reason, "unknown-target");

    const deleted = makeHarness({ target: deletedTargetThread });
    const deletedTarget = yield* (yield* deleted.service)
      .sendMessage(invocation, messageInput())
      .pipe(Effect.flip);
    assert.equal(deletedTarget.reason, "target-thread-deleted");

    assert.equal((yield* store.listOutboundByState("pending", 10)).length, 0);
    assert.deepEqual(activityKinds([...missing.commands, ...deleted.commands]), []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps delivery authoritative when the thread activity append fails", () =>
  Effect.gen(function* () {
    const { service } = makeHarness({ failCommands: true });
    const delivery = yield* service;
    const store = yield* WorkjetMailboxStore;

    const outcome = yield* delivery.sendMessage(invocation, messageInput());

    assert.equal(outcome._tag, "acknowledged");
    assert.equal(
      Option.getOrThrow(yield* store.getOutbound(outcome.envelopeId)).state,
      "delivered",
    );
  }).pipe(Effect.provide(testLayer)),
);

// ===============================
// Delegations
// ===============================

it.effect("progresses a same-environment delegation from queued to delivered", () =>
  Effect.gen(function* () {
    const { commands, service } = makeHarness();
    const delivery = yield* service;
    const store = yield* WorkjetMailboxStore;

    const outcome = yield* delivery.delegateTask(invocation, delegateInput());

    assert.equal(outcome.delivery._tag, "acknowledged");
    assert.equal(outcome.state, "delivered");
    assert.deepEqual(outcome.delegation.owner, {
      schemaVersion: 1,
      workspaceId: WORKSPACE,
      environmentId: LOCAL_ENVIRONMENT,
      threadId: TARGET_THREAD,
    });

    const record = Option.getOrThrow(yield* store.getDelegation(outcome.delegation.delegationId));
    assert.equal(record.state, "delivered");
    assert.isFalse(record.terminal);
    assert.equal(record.delegation.stateChangedAt, NOW);
    assert.equal(record.delegation.depth, 0);
    assert.equal(record.delegation.budget.expiresAt, "2026-08-19T14:00:00.000Z");

    assert.deepEqual(activityKinds(commands), [
      WORKJET_DELEGATION_SENT_ACTIVITY_KIND,
      WORKJET_DELEGATION_RECEIVED_ACTIVITY_KIND,
    ]);
    const received = activityFor(commands, WORKJET_DELEGATION_RECEIVED_ACTIVITY_KIND);
    if (received?.type !== "thread.activity.append") return;
    assert.equal(received.threadId, TARGET_THREAD);
    assert.deepEqual(received.activity.payload, {
      schemaVersion: 1,
      envelopeId: outcome.delivery.envelopeId,
      direction: "inbound",
      source: {
        workspaceId: WORKSPACE,
        environmentId: LOCAL_ENVIRONMENT,
        threadId: SOURCE_THREAD,
      },
      target: {
        workspaceId: WORKSPACE,
        environmentId: LOCAL_ENVIRONMENT,
        threadId: TARGET_THREAD,
      },
      disposition: "accepted-new",
      delegationId: outcome.delegation.delegationId,
      delegationState: "delivered",
      createdAt: NOW,
      expiresAt: "2026-08-19T13:00:00.000Z",
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps a cross-environment delegation queued and pending", () =>
  Effect.gen(function* () {
    const { commands, service } = makeHarness();
    const delivery = yield* service;
    const store = yield* WorkjetMailboxStore;

    const outcome = yield* delivery.delegateTask(
      invocation,
      delegateInput({ targetEnvironmentId: REMOTE_ENVIRONMENT }),
    );

    assert.equal(outcome.delivery._tag, "queued");
    assert.equal(outcome.state, "queued");
    const record = Option.getOrThrow(yield* store.getDelegation(outcome.delegation.delegationId));
    assert.equal(record.state, "queued");
    assert.equal(
      Option.getOrThrow(yield* store.getOutbound(outcome.delivery.envelopeId)).state,
      "pending",
    );
    assert.deepEqual(activityKinds(commands), [WORKJET_DELEGATION_SENT_ACTIVITY_KIND]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a delegation deeper than its own depth budget", () =>
  Effect.gen(function* () {
    const { commands, service } = makeHarness();
    const delivery = yield* service;
    const store = yield* WorkjetMailboxStore;

    const error = yield* delivery
      .delegateTask(
        invocation,
        delegateInput({ depth: 5, budget: { maxDepth: 4, maxReviewRounds: 0, ttlSeconds: 3_600 } }),
      )
      .pipe(Effect.flip);

    assert.equal(error.reason, "depth-exceeded");
    assert.equal((yield* store.listDelegationsByState("queued", 10)).length, 0);
    assert.deepEqual(activityKinds(commands), []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("stores an independent delegation row per send", () =>
  Effect.gen(function* () {
    const { service } = makeHarness();
    const delivery = yield* service;
    const store = yield* WorkjetMailboxStore;

    const first = yield* delivery.delegateTask(invocation, delegateInput());
    const second = yield* delivery.delegateTask(invocation, delegateInput());

    assert.notEqual(first.delegation.delegationId, second.delegation.delegationId);
    assert.equal((yield* store.listDelegationsByState("delivered", 10)).length, 2);
    assert.equal((yield* store.listDelegationsByState("queued", 10)).length, 0);
  }).pipe(Effect.provide(testLayer)),
);
