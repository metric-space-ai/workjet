// @effect-diagnostics preferSchemaOverJson:off -- redaction assertions inspect complete bounded MCP results.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WorkjetDelegationId,
  WorkjetContentDigest,
  WorkjetEnvelopeId,
  WorkjetMailboxError,
  WorkjetMeshWorkspaceId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import * as WorkjetMailboxDelivery from "../../../workjet/mailbox/WorkjetMailboxDelivery.ts";
import * as WorkjetSnapshotStore from "../../../workjet/mailbox/WorkjetSnapshotStore.ts";
import {
  DelegateTaskMcpTool,
  MailboxToolkitRegistrationLive,
  SendMessageMcpTool,
  WORKJET_DELEGATE_PROMPT_MAX_LENGTH,
  WORKJET_DELEGATE_TASK_TOOL_NAME,
  WORKJET_SEND_MESSAGE_TOOL_NAME,
  decodeDelegateTaskInput,
  decodeSendMessageInput,
  isMailboxToolVisible,
} from "./MailboxTool.ts";

const environmentId = EnvironmentId.make("environment-mailbox-tool");
const threadId = ThreadId.make("thread-orchestrator");
const targetThreadId = ThreadId.make("thread-target");
const workspaceId = WorkjetMeshWorkspaceId.make("workjet-mesh-room-1");
const envelopeId = WorkjetEnvelopeId.make("wjm-00000000-0000-4000-8000-000000000001");
const delegationId = WorkjetDelegationId.make("wjd-00000000-0000-4000-8000-000000000002");

const baseInvocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mailbox-tool",
  providerInstanceId: ProviderInstanceId.make("codex-main"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mailbox-tool-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/**
 * The tool is exercised against the REAL snapshot store on a throwaway state
 * directory. A stub would defeat the point of this slice: the assertion worth
 * making is that the digest the delegation carries can be resolved and
 * verified afterwards, which only a real content-addressed store can show.
 */
const makeSnapshotStoreLayer = (prefix: string) =>
  WorkjetSnapshotStore.WorkjetSnapshotStoreLive.pipe(
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix }))),
    Layer.provideMerge(NodeServices.layer),
  );

const makeTestLayer = (
  delivery: Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>,
  snapshotPrefix = "t3code-mailbox-tool-test-",
) =>
  MailboxToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.succeed(
        WorkjetMailboxDelivery.WorkjetMailboxDelivery,
        WorkjetMailboxDelivery.WorkjetMailboxDelivery.of({
          sendMessage: () => Effect.die("sendMessage must not run"),
          delegateTask: () => Effect.die("delegateTask must not run"),
          reply: () => Effect.die("reply must not run"),
          requestReview: () => Effect.die("requestReview must not run"),
          updateDelegation: () => Effect.die("updateDelegation must not run"),
          ...delivery,
        }),
      ),
    ),
    Layer.provideMerge(makeSnapshotStoreLayer(snapshotPrefix)),
  );

const sendArguments = {
  targetWorkspaceId: workspaceId,
  targetEnvironmentId: environmentId,
  targetThreadId,
  body: { _tag: "inline", text: "Please pick up the mailbox slice." },
} as const;

const delegatePrompt = "Implement the snapshot slice exactly as briefed.";

const delegateArguments = {
  targetWorkspaceId: workspaceId,
  targetEnvironmentId: environmentId,
  targetThreadId,
  prompt: delegatePrompt,
  scope: {
    files: ["apps/server/src/workjet/mailbox/WorkjetMailboxDelivery.ts"],
    nonGoals: "No transport, no relay, no UI.",
  },
  acceptance: "Focused delivery tests pass.",
  budget: { maxDepth: 4, maxReviewRounds: 2, ttlSeconds: 7_200 },
} as const;

it("is visible only to an exact orchestrator bearer scope", () => {
  expect(isMailboxToolVisible({ ...baseInvocation, workjetRole: "orchestrator" })).toBe(true);
  expect(isMailboxToolVisible({ ...baseInvocation, workjetRole: "standard" })).toBe(false);
  expect(isMailboxToolVisible({ ...baseInvocation, workjetRole: "worker" })).toBe(false);
  expect(isMailboxToolVisible(baseInvocation)).toBe(false);
});

it("declares both mailbox operations as non-idempotent open-world writes", () => {
  expect(SendMessageMcpTool.name).toBe(WORKJET_SEND_MESSAGE_TOOL_NAME);
  expect(DelegateTaskMcpTool.name).toBe(WORKJET_DELEGATE_TASK_TOOL_NAME);
  for (const tool of [SendMessageMcpTool, DelegateTaskMcpTool]) {
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(false);
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(true);
    const schema = Tool.getJsonSchema(tool) as {
      readonly additionalProperties?: boolean;
      readonly properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toHaveProperty("targetWorkspaceId");
    // The source workspace id is the environment's own mesh identity now.
    expect(schema.properties).not.toHaveProperty("workspaceId");
    expect(schema.properties).toHaveProperty("targetEnvironmentId");
    expect(schema.properties).toHaveProperty("targetThreadId");
  }
  // Only a delegation creates durable work on the target thread.
  expect(Context.get(SendMessageMcpTool.annotations, Tool.Destructive)).toBe(false);
  expect(Context.get(DelegateTaskMcpTool.annotations, Tool.Destructive)).toBe(true);
});

it.effect("rejects unknown keys, blank prose, and out-of-range bounds", () =>
  Effect.gen(function* () {
    const canary = "INPUT_CANARY_SHOULD_NOT_LEAK";
    const invalidSends = [
      { ...sendArguments, unknown: true },
      { ...sendArguments, body: { _tag: "inline", text: "   " } },
      { ...sendArguments, body: { _tag: "inline", text: "x".repeat(4_097) } },
      { ...sendArguments, body: { _tag: "sealed", payloadRef: "short", byteLength: 1 } },
      { ...sendArguments, body: { _tag: "inline", text: canary }, ttlSeconds: 1 },
      { ...sendArguments, body: { _tag: "inline", text: canary }, ttlSeconds: 604_801 },
      { ...sendArguments, body: { _tag: "inline", text: canary }, inReplyTo: "short" },
      { targetWorkspaceId: workspaceId, targetEnvironmentId: environmentId },
      { ...sendArguments, workspaceId },
    ];
    for (const payload of invalidSends) {
      const error = yield* decodeSendMessageInput(payload).pipe(Effect.flip);
      expect(error).toBeInstanceOf(McpSchema.InvalidParams);
      expect(JSON.stringify(error)).not.toContain(canary);
    }

    const invalidDelegations = [
      { ...delegateArguments, unknown: true },
      { ...delegateArguments, acceptance: "   " },
      { ...delegateArguments, scope: { ...delegateArguments.scope, files: [] } },
      {
        ...delegateArguments,
        scope: { ...delegateArguments.scope, files: ["../outside/the/repository.ts"] },
      },
      {
        ...delegateArguments,
        scope: { ...delegateArguments.scope, files: ["/absolute/path.ts"] },
      },
      { ...delegateArguments, budget: { maxDepth: 0, maxReviewRounds: 0, ttlSeconds: 3_600 } },
      { ...delegateArguments, budget: { maxDepth: 17, maxReviewRounds: 0, ttlSeconds: 3_600 } },
      { ...delegateArguments, budget: { maxDepth: 4, maxReviewRounds: 17, ttlSeconds: 3_600 } },
      { ...delegateArguments, depth: 17 },
      // The prompt is bounded TEXT now; a caller-asserted snapshot reference is
      // no longer part of the surface and is rejected like any unknown shape.
      { ...delegateArguments, prompt: "   " },
      { ...delegateArguments, prompt: "" },
      { ...delegateArguments, prompt: "p".repeat(WORKJET_DELEGATE_PROMPT_MAX_LENGTH + 1) },
      {
        ...delegateArguments,
        prompt: { snapshotRef: "cHJvbXB0LXNuYXBzaG90LXJlZi0wMDE", digest: "a".repeat(64) },
      },
    ];
    for (const payload of invalidDelegations) {
      const error = yield* decodeDelegateTaskInput(payload).pipe(Effect.flip);
      expect(error).toBeInstanceOf(McpSchema.InvalidParams);
    }
  }),
);

it.effect("denies direct calls for standard, worker, and missing roles", () => {
  const sendMessage = vi.fn(() => Effect.die("sendMessage must not run"));
  const delegateTask = vi.fn(() => Effect.die("delegateTask must not run"));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const workjetRole of ["standard", "worker", undefined] as const) {
      const invocation = {
        ...baseInvocation,
        ...(workjetRole === undefined ? {} : { workjetRole }),
      };
      for (const call of [
        { name: WORKJET_SEND_MESSAGE_TOOL_NAME, arguments: sendArguments },
        { name: WORKJET_DELEGATE_TASK_TOOL_NAME, arguments: delegateArguments },
      ]) {
        const result = yield* server
          .callTool(call)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({
          error: { _tag: "WorkjetMailboxError", reason: "unauthorized" },
        });
      }
    }
    expect(sendMessage).not.toHaveBeenCalled();
    expect(delegateTask).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      makeTestLayer({
        sendMessage,
        delegateTask,
      } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>),
    ),
  );
});

it.effect("returns the bounded acknowledged receipt for an orchestrator send", () => {
  const sendMessage = vi.fn(
    (
      _invocation: McpInvocationContext.McpInvocationScope,
      input: WorkjetMailboxDelivery.WorkjetMailboxSendMessageInput,
    ) => {
      expect(input.targetThreadId).toBe(targetThreadId);
      expect(input.targetWorkspaceId).toBe(workspaceId);
      expect(input.body._tag).toBe("inline");
      // The delivery input has no source workspace field at all.
      expect(input).not.toHaveProperty("workspaceId");
      return Effect.succeed({
        _tag: "acknowledged" as const,
        envelopeId,
        receipt: {
          schemaVersion: 1 as const,
          envelopeId,
          acknowledgedBy: {
            schemaVersion: 1 as const,
            workspaceId,
            environmentId,
            threadId: targetThreadId,
          },
          acknowledgedAt: "2026-08-19T12:00:00.000Z",
          disposition: "accepted-new" as const,
        },
      });
    },
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: WORKJET_SEND_MESSAGE_TOOL_NAME, arguments: sendArguments })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...baseInvocation,
          workjetRole: "orchestrator",
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      status: "acknowledged",
      envelopeId,
      disposition: "accepted-new",
      acknowledgedAt: "2026-08-19T12:00:00.000Z",
    });
    // The tool result never echoes the message body back to the harness.
    expect(JSON.stringify(result)).not.toContain(sendArguments.body.text);
    expect(sendMessage).toHaveBeenCalledOnce();
  }).pipe(
    Effect.provide(
      makeTestLayer({
        sendMessage,
      } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>),
    ),
  );
});

it.effect("stores the prompt and pins the delegation to the real snapshot digest", () => {
  const seen: { prompt?: WorkjetMailboxDelivery.WorkjetMailboxDelegateInput["prompt"] } = {};
  const delegateTask = vi.fn(
    (
      _invocation: McpInvocationContext.McpInvocationScope,
      input: WorkjetMailboxDelivery.WorkjetMailboxDelegateInput,
    ) => {
      expect(input.completion.acceptance).toBe(delegateArguments.acceptance);
      expect(input.budget.maxReviewRounds).toBe(2);
      seen.prompt = input.prompt;
      return Effect.succeed({
        delivery: {
          _tag: "acknowledged" as const,
          envelopeId,
          receipt: {
            schemaVersion: 1 as const,
            envelopeId,
            acknowledgedBy: {
              schemaVersion: 1 as const,
              workspaceId,
              environmentId,
              threadId: targetThreadId,
            },
            acknowledgedAt: "2026-08-19T12:00:00.000Z",
            disposition: "accepted-new" as const,
          },
        },
        delegation: {
          schemaVersion: 1 as const,
          delegationId,
          owner: {
            schemaVersion: 1 as const,
            workspaceId,
            environmentId,
            threadId: targetThreadId,
          },
        },
        state: "delivered" as const,
      });
    },
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: WORKJET_DELEGATE_TASK_TOOL_NAME, arguments: delegateArguments })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...baseInvocation,
          workjetRole: "orchestrator",
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      status: "acknowledged",
      envelopeId,
      delegationId,
      ownerEnvironmentId: environmentId,
      ownerThreadId: targetThreadId,
      state: "delivered",
      disposition: "accepted-new",
      acknowledgedAt: "2026-08-19T12:00:00.000Z",
    });
    expect(delegateTask).toHaveBeenCalledOnce();

    // The prompt reference is DERIVED, not echoed: the digest is the SHA-256
    // of the prompt the caller sent, and it resolves in the real store back to
    // that exact text.
    const prompt = seen.prompt;
    expect(prompt).toBeDefined();
    const expectedDigest = NodeCrypto.createHash("sha256")
      .update(Buffer.from(delegatePrompt, "utf8"))
      .digest("hex");
    expect(prompt?.digest).toBe(expectedDigest);
    expect(prompt?.byteLength).toBe(Buffer.byteLength(delegatePrompt, "utf8"));
    expect(prompt?.snapshotRef).toBe(
      WorkjetSnapshotStore.snapshotRefForDigest(WorkjetContentDigest.make(expectedDigest)),
    );

    const store = yield* WorkjetSnapshotStore.WorkjetSnapshotStore;
    expect(yield* store.get(WorkjetContentDigest.make(expectedDigest))).toBe(delegatePrompt);

    // Neither the prompt text nor its reference is echoed back to the harness.
    expect(JSON.stringify(result)).not.toContain(delegatePrompt);
    expect(JSON.stringify(result)).not.toContain(prompt?.snapshotRef ?? "");
  }).pipe(
    Effect.provide(
      makeTestLayer(
        {
          delegateTask,
        } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>,
        "t3code-mailbox-tool-delegate-",
      ),
    ),
  );
});

it.effect("refuses an oversized prompt before any snapshot is written", () => {
  const delegateTask = vi.fn(() => Effect.die("delegateTask must not run"));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const error = yield* server
      .callTool({
        name: WORKJET_DELEGATE_TASK_TOOL_NAME,
        arguments: {
          ...delegateArguments,
          prompt: "p".repeat(WORKJET_DELEGATE_PROMPT_MAX_LENGTH + 1),
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...baseInvocation,
          workjetRole: "orchestrator",
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.flip,
      );

    // Bounds are enforced by the input schema, so the store is never reached.
    expect(error).toBeInstanceOf(McpSchema.InvalidParams);
    expect(delegateTask).not.toHaveBeenCalled();

    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(config.stateDir, ...WorkjetSnapshotStore.WORKJET_SNAPSHOT_ROOT_SEGMENTS);
    expect(yield* fs.exists(root)).toBe(false);
  }).pipe(
    Effect.provide(
      makeTestLayer(
        {
          delegateTask,
        } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>,
        "t3code-mailbox-tool-oversized-",
      ),
    ),
  );
});

it.effect("reports a cross-environment send as queued without a receipt", () => {
  const sendMessage = () => Effect.succeed({ _tag: "queued" as const, envelopeId });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: WORKJET_SEND_MESSAGE_TOOL_NAME, arguments: sendArguments })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...baseInvocation,
          workjetRole: "orchestrator",
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      status: "queued",
      envelopeId,
    });
  }).pipe(
    Effect.provide(
      makeTestLayer({
        sendMessage,
      } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>),
    ),
  );
});

it.effect("keeps mailbox failures bounded and redacted", () => {
  const sendMessage = () =>
    Effect.fail(new WorkjetMailboxError({ reason: "target-thread-deleted" }));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: WORKJET_SEND_MESSAGE_TOOL_NAME, arguments: sendArguments })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...baseInvocation,
          workjetRole: "orchestrator",
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { reason: "target-thread-deleted" } },
    });
    expect(JSON.stringify(result)).not.toContain(sendArguments.body.text);
  }).pipe(
    Effect.provide(
      makeTestLayer({
        sendMessage,
      } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>),
    ),
  );
});
