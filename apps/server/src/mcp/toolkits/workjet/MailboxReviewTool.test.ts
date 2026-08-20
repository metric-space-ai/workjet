// @effect-diagnostics preferSchemaOverJson:off -- redaction assertions inspect complete bounded MCP results.
import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as ServerConfig from "../../../config.ts";
import * as WorkjetMailboxDelivery from "../../../workjet/mailbox/WorkjetMailboxDelivery.ts";
import * as WorkjetSnapshotStore from "../../../workjet/mailbox/WorkjetSnapshotStore.ts";
import {
  MailboxToolkitRegistrationLive,
  ReplyMcpTool,
  RequestReviewMcpTool,
  UpdateDelegationMcpTool,
  WORKJET_REPLY_TOOL_NAME,
  WORKJET_REQUEST_REVIEW_TOOL_NAME,
  WORKJET_UPDATE_DELEGATION_TOOL_NAME,
  decodeReplyInput,
  decodeRequestReviewInput,
  decodeUpdateDelegationInput,
} from "./MailboxTool.ts";

const environmentId = EnvironmentId.make("environment-review-tool");
const threadId = ThreadId.make("thread-orchestrator");
const targetThreadId = ThreadId.make("thread-target");
const workspaceId = WorkjetMeshWorkspaceId.make("workjet-mesh-room-1");
const envelopeId = WorkjetEnvelopeId.make("wjm-00000000-0000-4000-8000-000000000001");
const delegationId = WorkjetDelegationId.make("wjd-00000000-0000-4000-8000-000000000002");

const baseInvocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-review-tool",
  providerInstanceId: ProviderInstanceId.make("codex-main"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};

const orchestrator = { ...baseInvocation, workjetRole: "orchestrator" as const };

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "review-tool-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const makeSnapshotStoreLayer = (prefix: string) =>
  WorkjetSnapshotStore.WorkjetSnapshotStoreLive.pipe(
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix }))),
    Layer.provideMerge(NodeServices.layer),
  );

const makeTestLayer = (
  delivery: Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>,
  snapshotPrefix = "t3code-review-tool-test-",
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
          sendHandoff: () => Effect.die("sendHandoff must not run"),
          listReceivedHandoffs: () => Effect.die("listReceivedHandoffs must not run"),
          getReceivedHandoff: () => Effect.die("getReceivedHandoff must not run"),
          acceptHandoff: () => Effect.die("acceptHandoff must not run"),
          ...delivery,
        }),
      ),
    ),
    Layer.provideMerge(makeSnapshotStoreLayer(snapshotPrefix)),
  );

const acknowledgedSend = {
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
    acknowledgedAt: "2026-08-19T12:00:00.000Z" as const,
    disposition: "accepted-new" as const,
  },
};

const replyArguments = {
  targetWorkspaceId: workspaceId,
  targetEnvironmentId: environmentId,
  targetThreadId,
  delegationId,
  body: { _tag: "inline", text: "Picked it up, starting now." },
} as const;

const requestReviewArguments = {
  ...replyArguments,
  round: 1,
  body: { _tag: "inline", text: "Ready for review." },
} as const;

const updateArguments = {
  delegationId,
  update: { _tag: "cancel" },
} as const;

it("declares the three tools as orchestrator-only open-world writes with bounded schemas", () => {
  expect(ReplyMcpTool.name).toBe(WORKJET_REPLY_TOOL_NAME);
  expect(RequestReviewMcpTool.name).toBe(WORKJET_REQUEST_REVIEW_TOOL_NAME);
  expect(UpdateDelegationMcpTool.name).toBe(WORKJET_UPDATE_DELEGATION_TOOL_NAME);
  for (const tool of [ReplyMcpTool, RequestReviewMcpTool, UpdateDelegationMcpTool]) {
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(false);
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(true);
    const schema = Tool.getJsonSchema(tool) as { readonly additionalProperties?: boolean };
    expect(schema.additionalProperties).toBe(false);
  }
  // A reply changes no lifecycle; updating a delegation is destructive.
  expect(Context.get(ReplyMcpTool.annotations, Tool.Destructive)).toBe(false);
  expect(Context.get(UpdateDelegationMcpTool.annotations, Tool.Destructive)).toBe(true);
});

it.effect("rejects unknown keys, blank prose, and out-of-range bounds on every tool", () =>
  Effect.gen(function* () {
    const invalidReplies = [
      { ...replyArguments, unknown: true },
      { ...replyArguments, body: { _tag: "inline", text: "   " } },
      { ...replyArguments, delegationId: "short" },
    ];
    for (const payload of invalidReplies) {
      expect(yield* decodeReplyInput(payload).pipe(Effect.flip)).toBeInstanceOf(
        McpSchema.InvalidParams,
      );
    }

    const invalidReviews = [
      { ...requestReviewArguments, round: 0 },
      { ...requestReviewArguments, round: 17 },
      { ...requestReviewArguments, unknown: true },
    ];
    for (const payload of invalidReviews) {
      expect(yield* decodeRequestReviewInput(payload).pipe(Effect.flip)).toBeInstanceOf(
        McpSchema.InvalidParams,
      );
    }

    const invalidUpdates = [
      { delegationId, update: { _tag: "unknown-op" } },
      { delegationId, update: { _tag: "review", decision: "approve", round: 0 } },
      { delegationId, update: { _tag: "review", decision: "maybe", round: 1 } },
      { delegationId, update: { _tag: "cancel" }, unknown: true },
    ];
    for (const payload of invalidUpdates) {
      expect(yield* decodeUpdateDelegationInput(payload).pipe(Effect.flip)).toBeInstanceOf(
        McpSchema.InvalidParams,
      );
    }
  }),
);

it.effect("denies every tool for a non-orchestrator scope without touching delivery", () => {
  const reply = vi.fn(() => Effect.die("reply must not run"));
  const requestReview = vi.fn(() => Effect.die("requestReview must not run"));
  const updateDelegation = vi.fn(() => Effect.die("updateDelegation must not run"));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const workjetRole of ["standard", "worker", undefined] as const) {
      const invocation = {
        ...baseInvocation,
        ...(workjetRole === undefined ? {} : { workjetRole }),
      };
      for (const call of [
        { name: WORKJET_REPLY_TOOL_NAME, arguments: replyArguments },
        { name: WORKJET_REQUEST_REVIEW_TOOL_NAME, arguments: requestReviewArguments },
        { name: WORKJET_UPDATE_DELEGATION_TOOL_NAME, arguments: updateArguments },
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
    expect(reply).not.toHaveBeenCalled();
    expect(requestReview).not.toHaveBeenCalled();
    expect(updateDelegation).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      makeTestLayer({
        reply,
        requestReview,
        updateDelegation,
      } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>),
    ),
  );
});

it.effect("returns the bounded acknowledged receipt for an orchestrator reply", () => {
  const reply = vi.fn(
    (
      _invocation: McpInvocationContext.McpInvocationScope,
      input: WorkjetMailboxDelivery.WorkjetMailboxReplyInput,
    ) => {
      expect(input.delegationId).toBe(delegationId);
      expect(input.body._tag).toBe("inline");
      return Effect.succeed(acknowledgedSend);
    },
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: WORKJET_REPLY_TOOL_NAME, arguments: replyArguments })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, orchestrator),
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
    // The reply body is never echoed back to the harness.
    expect(JSON.stringify(result)).not.toContain(replyArguments.body.text);
    expect(reply).toHaveBeenCalledOnce();
  }).pipe(
    Effect.provide(
      makeTestLayer({
        reply,
      } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>),
    ),
  );
});

it.effect("returns the delegation state, reviews edge, and receipt for a review request", () => {
  const requestReview = vi.fn(
    (
      _invocation: McpInvocationContext.McpInvocationScope,
      input: WorkjetMailboxDelivery.WorkjetMailboxRequestReviewInput,
    ) => {
      expect(input.round).toBe(1);
      return Effect.succeed({
        delivery: acknowledgedSend,
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
        state: "review-requested" as const,
        edgeKind: "reviews" as const,
      });
    },
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: WORKJET_REQUEST_REVIEW_TOOL_NAME, arguments: requestReviewArguments })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, orchestrator),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      status: "acknowledged",
      envelopeId,
      delegationId,
      state: "review-requested",
      edgeKind: "reviews",
      disposition: "accepted-new",
      acknowledgedAt: "2026-08-19T12:00:00.000Z",
    });
    expect(requestReview).toHaveBeenCalledOnce();
  }).pipe(
    Effect.provide(
      makeTestLayer({
        requestReview,
      } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>),
    ),
  );
});

it.effect("returns the post-operation state and edge kind for a delegation update", () => {
  const updateDelegation = vi.fn(
    (
      _invocation: McpInvocationContext.McpInvocationScope,
      input: WorkjetMailboxDelivery.WorkjetMailboxUpdateDelegationInput,
    ) => {
      expect(input.update._tag).toBe("review");
      return Effect.succeed({
        delegationId,
        state: "completed" as const,
        edgeKind: "reviews" as const,
      });
    },
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: WORKJET_UPDATE_DELEGATION_TOOL_NAME,
        arguments: {
          delegationId,
          update: { _tag: "review", decision: "approve", round: 1 },
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, orchestrator),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      delegationId,
      state: "completed",
      edgeKind: "reviews",
    });
    expect(updateDelegation).toHaveBeenCalledOnce();
  }).pipe(
    Effect.provide(
      makeTestLayer({
        updateDelegation,
      } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>),
    ),
  );
});

it.effect("maps a loop-gate refusal to a bounded, redacted mailbox error", () => {
  const requestReview = () =>
    Effect.fail(new WorkjetMailboxError({ reason: "review-rounds-exceeded" }));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: WORKJET_REQUEST_REVIEW_TOOL_NAME, arguments: requestReviewArguments })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, orchestrator),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { reason: "review-rounds-exceeded" } },
    });
  }).pipe(
    Effect.provide(
      makeTestLayer({
        requestReview,
      } as unknown as Partial<WorkjetMailboxDelivery.WorkjetMailboxDeliveryShape>),
    ),
  );
});
