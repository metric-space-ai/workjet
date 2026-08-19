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
  type WorkjetThreadRole,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import type {
  WorkjetMailboxDelegateInput,
  WorkjetMailboxDeliveryShape,
  WorkjetMailboxSendMessageInput,
  WorkjetMailboxSenderScope,
} from "./WorkjetMailboxDelivery.ts";
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
  readonly prompts: Array<string>;
}

const doubles = (options: { readonly sameEnvironment?: boolean } = {}) => {
  const recorded: Recorded = { sends: [], delegations: [], prompts: [] };
  const acknowledged = options.sameEnvironment !== false;
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
  return { recorded, delivery, snapshots };
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

const handlers = (
  role: WorkjetThreadRole | "missing",
  options: { readonly deletedAt?: string | null; readonly sameEnvironment?: boolean } = {},
) => {
  const { recorded, delivery, snapshots } = doubles(options);
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
