// @effect-diagnostics preferSchemaOverJson:off -- redaction assertions inspect complete bounded MCP results.
import { expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WorkjetDelegationId,
  WorkjetEnvelopeId,
  WorkjetMailboxError,
  WorkjetMeshWorkspaceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkjetMailboxDelivery from "../../../workjet/mailbox/WorkjetMailboxDelivery.ts";
import {
  DelegateTaskMcpTool,
  MailboxToolkitRegistrationLive,
  SendMessageMcpTool,
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

const makeTestLayer = (delivery: Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>) =>
  MailboxToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.succeed(
        WorkjetMailboxDelivery.WorkjetMailboxDelivery,
        WorkjetMailboxDelivery.WorkjetMailboxDelivery.of({
          sendMessage: () => Effect.die("sendMessage must not run"),
          delegateTask: () => Effect.die("delegateTask must not run"),
          ...delivery,
        }),
      ),
    ),
  );

const sendArguments = {
  targetWorkspaceId: workspaceId,
  targetEnvironmentId: environmentId,
  targetThreadId,
  body: { _tag: "inline", text: "Please pick up the mailbox slice." },
} as const;

const delegateArguments = {
  targetWorkspaceId: workspaceId,
  targetEnvironmentId: environmentId,
  targetThreadId,
  prompt: {
    snapshotRef: "cHJvbXB0LXNuYXBzaG90LXJlZi0wMDE",
    digest: "a".repeat(63) + "b",
    byteLength: 4_096,
  },
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
      { ...delegateArguments, prompt: { ...delegateArguments.prompt, digest: "not-a-digest" } },
      {
        ...delegateArguments,
        prompt: { ...delegateArguments.prompt, byteLength: 8_388_609 },
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

it.effect("returns the delegation reference and lifecycle state for a delegation", () => {
  const delegateTask = vi.fn(
    (
      _invocation: McpInvocationContext.McpInvocationScope,
      input: WorkjetMailboxDelivery.WorkjetMailboxDelegateInput,
    ) => {
      expect(input.completion.acceptance).toBe(delegateArguments.acceptance);
      expect(input.budget.maxReviewRounds).toBe(2);
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
    expect(JSON.stringify(result)).not.toContain(delegateArguments.prompt.snapshotRef);
    expect(delegateTask).toHaveBeenCalledOnce();
  }).pipe(
    Effect.provide(
      makeTestLayer({
        delegateTask,
      } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>),
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
