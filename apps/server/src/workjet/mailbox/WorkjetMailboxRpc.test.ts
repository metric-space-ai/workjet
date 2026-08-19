// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  WorkjetContentDigest,
  WorkjetDelegationId,
  WorkjetEnvelopeId,
  WorkjetMailboxError,
  WorkjetMeshWorkspaceId,
  WorkjetRepositoryPath,
  WorkjetSealedPayloadRef,
  type OrchestrationThread,
  type WorkjetMailboxDelegateTaskRpcInput,
  type WorkjetMailboxSendMessageRpcInput,
  type WorkjetDelegation,
  type WorkjetThreadRole,
  type WorkjetWorkerAddress,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import type {
  WorkjetMailboxDelegateInput,
  WorkjetMailboxDeliveryShape,
  WorkjetMailboxReplyInput,
  WorkjetMailboxRequestReviewInput,
  WorkjetMailboxSendMessageInput,
  WorkjetMailboxSenderScope,
  WorkjetMailboxUpdateDelegationInput,
} from "./WorkjetMailboxDelivery.ts";
import type { WorkjetDelegationExecutorShape } from "./WorkjetDelegationExecutor.ts";
import { makeWorkjetMailboxRpcHandlers } from "./WorkjetMailboxRpc.ts";
import type { WorkjetSnapshotStoreShape } from "./WorkjetSnapshotStore.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-a");
const WORKSPACE_ID = WorkjetMeshWorkspaceId.make("ctox-business-os:mesh-alpha");
const SOURCE_THREAD_ID = ThreadId.make("thread-orchestrator");
const TARGET_THREAD_ID = ThreadId.make("thread-worker");
const ENVELOPE_ID = WorkjetEnvelopeId.make("env-0123456789abcdef");
const DELEGATION_ID = WorkjetDelegationId.make("dlg-0123456789abcdef");
const DIGEST = WorkjetContentDigest.make("a".repeat(64));
const SNAPSHOT_REF = WorkjetSealedPayloadRef.make(Buffer.alloc(32, 7).toString("base64url"));
const NOW = "2026-08-18T10:00:00.000Z";

const thread = (
  role: WorkjetThreadRole,
  overrides: { readonly deletedAt?: string | null } = {},
): OrchestrationThread =>
  ({
    id: SOURCE_THREAD_ID,
    deletedAt: overrides.deletedAt ?? null,
    workjetConfig: {
      schemaVersion: 1,
      role,
      parent: null,
      managedInstructions: "",
      enabledCapabilityIds: [],
    },
  }) as unknown as OrchestrationThread;

/** The durable delegation body the reassignment port re-points at a new thread. */
const delegation: WorkjetDelegation = {
  schemaVersion: 1,
  envelopeId: ENVELOPE_ID,
  delegationId: DELEGATION_ID,
  source: {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    environmentId: ENVIRONMENT_ID,
    threadId: SOURCE_THREAD_ID,
  },
  target: {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    environmentId: ENVIRONMENT_ID,
    threadId: TARGET_THREAD_ID,
  },
  createdAt: NOW,
  expiresAt: "2026-08-18T11:00:00.000Z",
  prompt: { schemaVersion: 1, snapshotRef: SNAPSHOT_REF, digest: DIGEST, byteLength: 32 },
  scope: {
    schemaVersion: 1,
    files: [WorkjetRepositoryPath.make("apps/server/src/workjet/mailbox/WorkjetMailboxStore.ts")],
    nonGoals: "No contract changes.",
  },
  completion: { schemaVersion: 1, acceptance: "The focused test run is green." },
  budget: { maxDepth: 2, maxReviewRounds: 1, ttlSeconds: 3_600 },
  state: "delivered",
  stateChangedAt: NOW,
  depth: 0,
};

const query = (result: Option.Option<OrchestrationThread>) => ({
  getThreadDetailById: () => Effect.succeed(result),
});

interface Recorded {
  readonly sends: Array<{
    readonly sender: WorkjetMailboxSenderScope;
    readonly input: WorkjetMailboxSendMessageInput;
  }>;
  readonly delegations: Array<{
    readonly sender: WorkjetMailboxSenderScope;
    readonly input: WorkjetMailboxDelegateInput;
  }>;
  readonly replies: Array<{
    readonly sender: WorkjetMailboxSenderScope;
    readonly input: WorkjetMailboxReplyInput;
  }>;
  readonly reviews: Array<{
    readonly sender: WorkjetMailboxSenderScope;
    readonly input: WorkjetMailboxRequestReviewInput;
  }>;
  readonly updates: Array<{
    readonly sender: WorkjetMailboxSenderScope;
    readonly input: WorkjetMailboxUpdateDelegationInput;
  }>;
  readonly prompts: Array<string>;
  readonly reassignments: Array<{
    readonly delegationId: WorkjetDelegationId;
    readonly newTarget: WorkjetWorkerAddress;
  }>;
}

const doubles = (
  options: {
    readonly sameEnvironment?: boolean;
    readonly reassignRefusal?: WorkjetMailboxError["reason"];
  } = {},
) => {
  const recorded: Recorded = {
    sends: [],
    delegations: [],
    replies: [],
    reviews: [],
    updates: [],
    prompts: [],
    reassignments: [],
  };
  const acknowledged = options.sameEnvironment !== false;
  const sendOutcome = (targetEnvironmentId: EnvironmentId, targetThreadId: ThreadId) =>
    acknowledged
      ? ({
          _tag: "acknowledged",
          envelopeId: ENVELOPE_ID,
          receipt: {
            schemaVersion: 1,
            envelopeId: ENVELOPE_ID,
            acknowledgedBy: {
              schemaVersion: 1,
              workspaceId: WORKSPACE_ID,
              environmentId: targetEnvironmentId,
              threadId: targetThreadId,
            },
            acknowledgedAt: NOW,
            disposition: "accepted-new",
          },
        } as const)
      : ({ _tag: "queued", envelopeId: ENVELOPE_ID } as const);
  const delivery: WorkjetMailboxDeliveryShape = {
    sendMessage: (sender, input) => {
      recorded.sends.push({ sender, input });
      return Effect.succeed(
        acknowledged
          ? {
              _tag: "acknowledged",
              envelopeId: ENVELOPE_ID,
              receipt: {
                schemaVersion: 1,
                envelopeId: ENVELOPE_ID,
                acknowledgedBy: {
                  schemaVersion: 1,
                  workspaceId: WORKSPACE_ID,
                  environmentId: input.targetEnvironmentId,
                  threadId: input.targetThreadId,
                },
                acknowledgedAt: NOW,
                disposition: "accepted-new",
              },
            }
          : { _tag: "queued", envelopeId: ENVELOPE_ID },
      );
    },
    delegateTask: (sender, input) => {
      recorded.delegations.push({ sender, input });
      return Effect.succeed({
        delivery: acknowledged
          ? {
              _tag: "acknowledged",
              envelopeId: ENVELOPE_ID,
              receipt: {
                schemaVersion: 1,
                envelopeId: ENVELOPE_ID,
                acknowledgedBy: {
                  schemaVersion: 1,
                  workspaceId: WORKSPACE_ID,
                  environmentId: input.targetEnvironmentId,
                  threadId: input.targetThreadId,
                },
                acknowledgedAt: NOW,
                disposition: "accepted-new",
              },
            }
          : { _tag: "queued", envelopeId: ENVELOPE_ID },
        delegation: {
          schemaVersion: 1,
          delegationId: DELEGATION_ID,
          owner: {
            schemaVersion: 1,
            workspaceId: WORKSPACE_ID,
            environmentId: input.targetEnvironmentId,
            threadId: input.targetThreadId,
          },
        },
        state: acknowledged ? "delivered" : "queued",
      });
    },
    reply: (sender, input) => {
      recorded.replies.push({ sender, input });
      return Effect.succeed(sendOutcome(input.targetEnvironmentId, input.targetThreadId));
    },
    requestReview: (sender, input) => {
      recorded.reviews.push({ sender, input });
      return Effect.succeed({
        delivery: sendOutcome(input.targetEnvironmentId, input.targetThreadId),
        delegation: {
          schemaVersion: 1,
          delegationId: input.delegationId,
          owner: {
            schemaVersion: 1,
            workspaceId: WORKSPACE_ID,
            environmentId: input.targetEnvironmentId,
            threadId: input.targetThreadId,
          },
        },
        state: "review-requested",
        edgeKind: "reviews",
      });
    },
    updateDelegation: (sender, input) => {
      recorded.updates.push({ sender, input });
      const state =
        input.update._tag === "cancel"
          ? ("cancelled" as const)
          : input.update._tag === "review"
            ? input.update.decision === "approve"
              ? ("completed" as const)
              : ("changes-requested" as const)
            : input.update._tag === "revise"
              ? ("running" as const)
              : ("needs-input" as const);
      const edgeKind =
        input.update._tag === "cancel"
          ? undefined
          : input.update._tag === "review"
            ? ("reviews" as const)
            : input.update._tag === "revise"
              ? ("revises" as const)
              : ("follows-up" as const);
      return Effect.succeed({
        delegationId: input.delegationId,
        state,
        ...(edgeKind !== undefined ? { edgeKind } : {}),
      });
    },
  };
  const snapshots = {
    put: (text: string) => {
      recorded.prompts.push(text);
      return Effect.succeed({
        snapshotRef: SNAPSHOT_REF,
        digest: DIGEST,
        byteLength: Buffer.byteLength(text, "utf8"),
      });
    },
  } as unknown as WorkjetSnapshotStoreShape;
  // The reconciler's reassignment port. It records the call and answers with
  // the record the real store returns: the delegation re-pointed at the new
  // target, with its lifecycle state deliberately UNCHANGED.
  const reassign: WorkjetDelegationExecutorShape["reassign"] = (input) => {
    recorded.reassignments.push(input);
    if (options.reassignRefusal !== undefined) {
      return Effect.fail(new WorkjetMailboxError({ reason: options.reassignRefusal }));
    }
    return Effect.succeed({
      delegationId: input.delegationId,
      delegation: { ...delegation, target: input.newTarget },
      state: "delivered",
      stateChangedAtMillis: Date.parse(NOW),
      terminal: false,
    });
  };
  return { recorded, delivery, snapshots, reassign };
};

const sendInput: WorkjetMailboxSendMessageRpcInput = {
  sourceThreadId: SOURCE_THREAD_ID,
  targetEnvironmentId: ENVIRONMENT_ID,
  targetThreadId: TARGET_THREAD_ID,
  body: { _tag: "inline", text: "Please look at the failing test." },
};

const delegateInput: WorkjetMailboxDelegateTaskRpcInput = {
  sourceThreadId: SOURCE_THREAD_ID,
  targetEnvironmentId: ENVIRONMENT_ID,
  targetThreadId: TARGET_THREAD_ID,
  prompt: "Fix the flaky mailbox store test.",
  scope: {
    files: [WorkjetRepositoryPath.make("apps/server/src/workjet/mailbox/WorkjetMailboxStore.ts")],
    nonGoals: "No contract changes.",
  },
  acceptance: "The focused test run is green.",
  budget: { maxDepth: 2, maxReviewRounds: 1, ttlSeconds: 3_600 },
};

const replyInput = {
  sourceThreadId: SOURCE_THREAD_ID,
  targetEnvironmentId: ENVIRONMENT_ID,
  targetThreadId: TARGET_THREAD_ID,
  delegationId: DELEGATION_ID,
  body: { _tag: "inline", text: "Thanks, one more thing." } as const,
} as const;

const requestReviewInput = {
  sourceThreadId: SOURCE_THREAD_ID,
  targetEnvironmentId: ENVIRONMENT_ID,
  targetThreadId: TARGET_THREAD_ID,
  delegationId: DELEGATION_ID,
  round: 1 as const,
  body: { _tag: "inline", text: "Please review." } as const,
} as const;

const updateInput = {
  sourceThreadId: SOURCE_THREAD_ID,
  delegationId: DELEGATION_ID,
  update: { _tag: "cancel" } as const,
} as const;

const handlers = (
  role: WorkjetThreadRole | "missing",
  options: {
    readonly deletedAt?: string | null;
    readonly sameEnvironment?: boolean;
    readonly reassignRefusal?: WorkjetMailboxError["reason"];
  } = {},
) => {
  const { recorded, delivery, snapshots, reassign } = doubles(options);
  return {
    recorded,
    handlers: makeWorkjetMailboxRpcHandlers({
      delivery,
      snapshots,
      query: query(
        role === "missing"
          ? Option.none()
          : Option.some(thread(role, { deletedAt: options.deletedAt ?? null })),
      ),
      workspaceId: WORKSPACE_ID,
      environmentId: ENVIRONMENT_ID,
      reassign,
    }),
  };
};

it.effect("sends from an orchestrator thread with a server-derived source address", () =>
  Effect.gen(function* () {
    const { recorded, handlers: rpc } = handlers("orchestrator");

    const result = yield* rpc.sendMessage(sendInput);

    expect(result).toEqual({
      schemaVersion: 1,
      status: "acknowledged",
      envelopeId: ENVELOPE_ID,
      disposition: "accepted-new",
      acknowledgedAt: NOW,
    });
    expect(recorded.sends).toHaveLength(1);
    // The source address is the SERVER's environment plus the validated
    // thread; nothing in the payload chose it.
    expect(recorded.sends[0]?.sender).toEqual({
      environmentId: ENVIRONMENT_ID,
      threadId: SOURCE_THREAD_ID,
    });
    // A client cannot know this server's opaque mesh workspace id, so an
    // omitted target workspace resolves to this server's own.
    expect(recorded.sends[0]?.input.targetWorkspaceId).toBe(WORKSPACE_ID);
  }),
);

it.effect("reports a cross-environment target as queued", () =>
  Effect.gen(function* () {
    const { handlers: rpc } = handlers("orchestrator", { sameEnvironment: false });

    const result = yield* rpc.sendMessage({
      ...sendInput,
      targetEnvironmentId: EnvironmentId.make("environment-remote"),
      body: { _tag: "sealed", payloadRef: SNAPSHOT_REF, byteLength: 2_048 },
    });

    expect(result).toEqual({ schemaVersion: 1, status: "queued", envelopeId: ENVELOPE_ID });
  }),
);

it.effect("keeps a caller-supplied target mesh workspace id", () =>
  Effect.gen(function* () {
    const { recorded, handlers: rpc } = handlers("orchestrator");
    const other = WorkjetMeshWorkspaceId.make("ctox-business-os:mesh-beta");

    yield* rpc.sendMessage({ ...sendInput, targetWorkspaceId: other });

    expect(recorded.sends[0]?.input.targetWorkspaceId).toBe(other);
  }),
);

it.effect("stores the delegation prompt itself and returns the delegation reference", () =>
  Effect.gen(function* () {
    const { recorded, handlers: rpc } = handlers("orchestrator");

    const result = yield* rpc.delegateTask(delegateInput);

    // The server writes the bytes, so the digest on the delegation describes
    // content it actually stored rather than a caller assertion.
    expect(recorded.prompts).toEqual(["Fix the flaky mailbox store test."]);
    expect(recorded.delegations[0]?.input.prompt).toEqual({
      schemaVersion: 1,
      snapshotRef: SNAPSHOT_REF,
      digest: DIGEST,
      byteLength: Buffer.byteLength(delegateInput.prompt, "utf8"),
    });
    expect(result).toEqual({
      schemaVersion: 1,
      status: "acknowledged",
      envelopeId: ENVELOPE_ID,
      delegationId: DELEGATION_ID,
      ownerEnvironmentId: ENVIRONMENT_ID,
      ownerThreadId: TARGET_THREAD_ID,
      state: "delivered",
      disposition: "accepted-new",
      acknowledgedAt: NOW,
    });
  }),
);

for (const scenario of [
  { label: "a standard thread", role: "standard" as const, deletedAt: null },
  { label: "a worker thread", role: "worker" as const, deletedAt: null },
  { label: "a deleted orchestrator thread", role: "orchestrator" as const, deletedAt: NOW },
  { label: "a thread that does not exist", role: "missing" as const, deletedAt: null },
]) {
  it.effect(`refuses to send from ${scenario.label}`, () =>
    Effect.gen(function* () {
      const { recorded, handlers: rpc } = handlers(scenario.role, {
        deletedAt: scenario.deletedAt,
      });

      const send = yield* Effect.exit(rpc.sendMessage(sendInput));
      const delegate = yield* Effect.exit(rpc.delegateTask(delegateInput));

      for (const exit of [send, delegate]) {
        expect(Exit.isFailure(exit)).toBe(true);
      }
      // The refusal happens BEFORE anything durable: no envelope, no snapshot.
      expect(recorded.sends).toHaveLength(0);
      expect(recorded.delegations).toHaveLength(0);
      expect(recorded.prompts).toHaveLength(0);
    }),
  );
}

it.effect("answers an unauthorized source with the bounded mailbox reason only", () =>
  Effect.gen(function* () {
    const { handlers: rpc } = handlers("worker");

    const error = yield* Effect.flip(rpc.sendMessage(sendInput));

    expect(error).toBeInstanceOf(WorkjetMailboxError);
    expect(error.reason).toBe("unauthorized");
    // The three refused cases are indistinguishable on the wire: a client that
    // may not send from a thread must not learn whether that thread exists.
    const missing = yield* Effect.flip(handlers("missing").handlers.sendMessage(sendInput));
    expect(missing.reason).toBe("unauthorized");
  }),
);

it.effect("maps an oversized prompt onto payload-too-large and never delegates", () =>
  Effect.gen(function* () {
    const { recorded, delivery } = doubles();
    const rpc = makeWorkjetMailboxRpcHandlers({
      reassign: () => Effect.fail(new WorkjetMailboxError({ reason: "mailbox-unavailable" })),
      delivery,
      snapshots: {
        put: () => Effect.fail({ _tag: "WorkjetSnapshotTooLargeError" }),
      } as unknown as WorkjetSnapshotStoreShape,
      query: query(Option.some(thread("orchestrator"))),
      workspaceId: WORKSPACE_ID,
      environmentId: ENVIRONMENT_ID,
    });

    const error = yield* Effect.flip(rpc.delegateTask(delegateInput));

    expect(error.reason).toBe("payload-too-large");
    expect(recorded.delegations).toHaveLength(0);
  }),
);

it.effect("replies on a delegation thread with a server-derived source address", () =>
  Effect.gen(function* () {
    const { recorded, handlers: rpc } = handlers("orchestrator");

    const result = yield* rpc.reply(replyInput);

    expect(result).toEqual({
      schemaVersion: 1,
      status: "acknowledged",
      envelopeId: ENVELOPE_ID,
      disposition: "accepted-new",
      acknowledgedAt: NOW,
    });
    expect(recorded.replies).toHaveLength(1);
    expect(recorded.replies[0]?.sender).toEqual({
      environmentId: ENVIRONMENT_ID,
      threadId: SOURCE_THREAD_ID,
    });
    expect(recorded.replies[0]?.input.delegationId).toBe(DELEGATION_ID);
    // An omitted target workspace resolves to this server's own.
    expect(recorded.replies[0]?.input.targetWorkspaceId).toBe(WORKSPACE_ID);
  }),
);

it.effect("requests review and returns the delegation state plus the reviews edge", () =>
  Effect.gen(function* () {
    const { recorded, handlers: rpc } = handlers("orchestrator");

    const result = yield* rpc.requestReview(requestReviewInput);

    expect(result).toEqual({
      schemaVersion: 1,
      status: "acknowledged",
      envelopeId: ENVELOPE_ID,
      delegationId: DELEGATION_ID,
      state: "review-requested",
      edgeKind: "reviews",
      disposition: "accepted-new",
      acknowledgedAt: NOW,
    });
    expect(recorded.reviews[0]?.input.round).toBe(1);
  }),
);

it.effect("reports a cross-environment review request as queued", () =>
  Effect.gen(function* () {
    const { handlers: rpc } = handlers("orchestrator", { sameEnvironment: false });

    const result = yield* rpc.requestReview({
      ...requestReviewInput,
      targetEnvironmentId: EnvironmentId.make("environment-remote"),
      body: { _tag: "sealed", payloadRef: SNAPSHOT_REF, byteLength: 1_024 },
    });

    expect(result).toEqual({
      schemaVersion: 1,
      status: "queued",
      envelopeId: ENVELOPE_ID,
      delegationId: DELEGATION_ID,
      state: "review-requested",
      edgeKind: "reviews",
    });
  }),
);

it.effect("updates a delegation and returns the resulting state", () =>
  Effect.gen(function* () {
    const { recorded, handlers: rpc } = handlers("orchestrator");

    const cancelled = yield* rpc.updateDelegation(updateInput);
    expect(cancelled).toEqual({
      schemaVersion: 1,
      delegationId: DELEGATION_ID,
      state: "cancelled",
    });

    const approved = yield* rpc.updateDelegation({
      sourceThreadId: SOURCE_THREAD_ID,
      delegationId: DELEGATION_ID,
      update: { _tag: "review", decision: "approve", round: 1, reasons: ["ships it"] },
    });
    expect(approved).toEqual({
      schemaVersion: 1,
      delegationId: DELEGATION_ID,
      state: "completed",
      edgeKind: "reviews",
    });
    // The review reasons are forwarded verbatim to the delivery service.
    expect(recorded.updates[1]?.input.update).toEqual({
      _tag: "review",
      decision: "approve",
      round: 1,
      reasons: ["ships it"],
    });
    // The actor identity is the server environment plus the validated thread.
    expect(recorded.updates[0]?.sender).toEqual({
      environmentId: ENVIRONMENT_ID,
      threadId: SOURCE_THREAD_ID,
    });
  }),
);

for (const scenario of [
  { label: "a standard thread", role: "standard" as const, deletedAt: null },
  { label: "a worker thread", role: "worker" as const, deletedAt: null },
  { label: "a deleted orchestrator thread", role: "orchestrator" as const, deletedAt: NOW },
  { label: "a thread that does not exist", role: "missing" as const, deletedAt: null },
]) {
  it.effect(`refuses reply / review / update from ${scenario.label}`, () =>
    Effect.gen(function* () {
      const { recorded, handlers: rpc } = handlers(scenario.role, {
        deletedAt: scenario.deletedAt,
      });

      const reply = yield* Effect.exit(rpc.reply(replyInput));
      const review = yield* Effect.exit(rpc.requestReview(requestReviewInput));
      const update = yield* Effect.exit(rpc.updateDelegation(updateInput));

      expect(Exit.isFailure(reply)).toBe(true);
      expect(Exit.isFailure(review)).toBe(true);
      expect(Exit.isFailure(update)).toBe(true);
      // The refusal happens BEFORE any durable delivery-service effect.
      expect(recorded.replies).toHaveLength(0);
      expect(recorded.reviews).toHaveLength(0);
      expect(recorded.updates).toHaveLength(0);
    }),
  );
}

it.effect("answers an unauthorized update with the bounded mailbox reason only", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(handlers("worker").handlers.updateDelegation(updateInput));

    expect(error).toBeInstanceOf(WorkjetMailboxError);
    expect(error.reason).toBe("unauthorized");
  }),
);

// ===============================
// Reassignment
// ===============================

const REASSIGN_THREAD_ID = ThreadId.make("thread-second-worker");

const reassignInput = {
  sourceThreadId: SOURCE_THREAD_ID,
  delegationId: DELEGATION_ID,
  targetEnvironmentId: ENVIRONMENT_ID,
  targetThreadId: REASSIGN_THREAD_ID,
} as const;

it.effect("reassigns a delegation to another local thread and returns the new target", () =>
  Effect.gen(function* () {
    const { recorded, handlers: rpc } = handlers("orchestrator");

    const result = yield* rpc.reassignDelegation(reassignInput);

    expect(result).toEqual({
      schemaVersion: 1,
      delegationId: DELEGATION_ID,
      state: "delivered",
      targetEnvironmentId: ENVIRONMENT_ID,
      targetThreadId: REASSIGN_THREAD_ID,
    });
    // The server substitutes its OWN mesh workspace id when the client omits one.
    expect(recorded.reassignments).toEqual([
      {
        delegationId: DELEGATION_ID,
        newTarget: {
          schemaVersion: 1,
          workspaceId: WORKSPACE_ID,
          environmentId: ENVIRONMENT_ID,
          threadId: REASSIGN_THREAD_ID,
        },
      },
    ]);
  }),
);

it.effect("keeps a caller-supplied target mesh workspace id on a reassignment", () =>
  Effect.gen(function* () {
    const workspaceId = WorkjetMeshWorkspaceId.make("ctox-business-os:mesh-beta");
    const { recorded, handlers: rpc } = handlers("orchestrator");

    yield* rpc.reassignDelegation({ ...reassignInput, targetWorkspaceId: workspaceId });

    expect(recorded.reassignments[0]?.newTarget.workspaceId).toBe(workspaceId);
  }),
);

it.effect("refuses a cross-environment reassignment before touching the store", () =>
  Effect.gen(function* () {
    const { recorded, handlers: rpc } = handlers("orchestrator");

    const error = yield* Effect.flip(
      rpc.reassignDelegation({
        ...reassignInput,
        targetEnvironmentId: EnvironmentId.make("environment-b"),
      }),
    );

    expect(error).toBeInstanceOf(WorkjetMailboxError);
    expect(error.reason).toBe("unknown-target");
    expect(recorded.reassignments).toHaveLength(0);
  }),
);

for (const scenario of [
  { label: "a standard thread", role: "standard" as const, deletedAt: null },
  { label: "a worker thread", role: "worker" as const, deletedAt: null },
  { label: "a deleted orchestrator thread", role: "orchestrator" as const, deletedAt: NOW },
  { label: "a thread that does not exist", role: "missing" as const, deletedAt: null },
]) {
  it.effect(`refuses a reassignment from ${scenario.label}`, () =>
    Effect.gen(function* () {
      const { recorded, handlers: rpc } = handlers(scenario.role, {
        deletedAt: scenario.deletedAt,
      });

      const error = yield* Effect.flip(rpc.reassignDelegation(reassignInput));

      expect(error).toBeInstanceOf(WorkjetMailboxError);
      expect(error.reason).toBe("unauthorized");
      // The refusal happens BEFORE any durable store effect.
      expect(recorded.reassignments).toHaveLength(0);
    }),
  );
}

it.effect("surfaces the store's invalid-state-transition refusal unchanged", () =>
  Effect.gen(function* () {
    const { handlers: rpc } = handlers("orchestrator", {
      reassignRefusal: "invalid-state-transition",
    });

    const error = yield* Effect.flip(rpc.reassignDelegation(reassignInput));

    expect(error).toBeInstanceOf(WorkjetMailboxError);
    expect(error.reason).toBe("invalid-state-transition");
  }),
);
