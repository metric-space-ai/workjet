import {
  EnvironmentId,
  ThreadId,
  WorkjetContentDigest,
  WorkjetDelegationId,
  WorkjetEnvelopeId,
  WorkjetMeshWorkspaceId,
  WorkjetPayloadByteLength,
  WorkjetRepositoryPath,
  WorkjetSealedPayloadRef,
  WorkjetDelegationState,
  WorkjetDeliveryDisposition,
  WorkjetMailboxTimestamp,
  type WorkjetMessageBody,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkjetMailboxDelivery from "../../../workjet/mailbox/WorkjetMailboxDelivery.ts";

/**
 * The first two harness-neutral Workjet mailbox tools (docs/workjet-plan.md →
 * "Expose harness-neutral MCP tools `workjet_send_message`,
 * `workjet_delegate_task` …"). Every harness receives the SAME bounded schemas
 * and the SAME authorization boundary from the per-session T3 MCP server, so
 * nothing here may branch on provider, harness, or model.
 *
 * Authorization mirrors `workjet_dispatch_worker` exactly: orchestrator-scoped
 * visibility plus a server-side `requireWorkjetOrchestrator` check on every
 * call. Worker-initiated traffic (`workjet_reply`, `workjet_update_delegation`)
 * and the narrowly scoped per-operation ACLs are separate, still-open plan
 * items; widening the boundary here before those land would grant every worker
 * cross-thread send rights with no ACL to constrain it.
 */

export const WORKJET_SEND_MESSAGE_TOOL_NAME = "workjet_send_message";
export const WORKJET_DELEGATE_TASK_TOOL_NAME = "workjet_delegate_task";

// ===============================
// Bounded input schemas
// ===============================

const TtlSeconds = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(WorkjetMailboxDelivery.WORKJET_MAILBOX_MIN_TTL_SECONDS),
  Schema.isLessThanOrEqualTo(WorkjetMailboxDelivery.WORKJET_MAILBOX_MAX_TTL_SECONDS),
);

/**
 * Local `inline` bodies exist only for the same-environment fast path; a
 * cross-environment target requires the sealed form, which the delivery service
 * enforces. Both variants are bounded exactly like the wire contract.
 */
const MessageBodyInput = Schema.Union([
  Schema.TaggedStruct("inline", {
    text: Schema.String.check(
      Schema.makeFilter((value) => value.trim().length > 0 || "text must be nonblank"),
      Schema.isMaxLength(4_096),
    ),
  }),
  Schema.TaggedStruct("sealed", {
    payloadRef: WorkjetSealedPayloadRef,
    byteLength: WorkjetPayloadByteLength,
  }),
]);

/**
 * Only the TARGET address is caller-supplied. The source workspace id used to
 * be an input field (`workspaceId`) that silently served as BOTH endpoints;
 * since the environment owns a durable mesh identity, the source workspace is
 * taken from `WorkjetMeshIdentity` inside the delivery service and a harness
 * can no longer choose the workspace it claims to send from.
 */
const TargetAddressFields = {
  targetWorkspaceId: WorkjetMeshWorkspaceId,
  targetEnvironmentId: EnvironmentId,
  targetThreadId: ThreadId,
} as const;

export const WorkjetSendMessageInputSchema = Schema.Struct({
  ...TargetAddressFields,
  body: MessageBodyInput,
  ttlSeconds: Schema.optional(TtlSeconds),
  inReplyTo: Schema.optional(WorkjetEnvelopeId),
});

const DelegationScopeInput = Schema.Struct({
  files: Schema.Array(WorkjetRepositoryPath).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  nonGoals: Schema.String.check(
    Schema.makeFilter((value) => value.trim().length > 0 || "nonGoals must be nonblank"),
    Schema.isMaxLength(4_096),
  ),
});

const DelegationBudgetInput = Schema.Struct({
  maxDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(16)),
  maxReviewRounds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(16),
  ),
  ttlSeconds: TtlSeconds,
});

const PromptSnapshotInput = Schema.Struct({
  snapshotRef: WorkjetSealedPayloadRef,
  digest: WorkjetContentDigest,
  byteLength: WorkjetPayloadByteLength,
});

export const WorkjetDelegateTaskInputSchema = Schema.Struct({
  ...TargetAddressFields,
  prompt: PromptSnapshotInput,
  scope: DelegationScopeInput,
  acceptance: Schema.String.check(
    Schema.makeFilter((value) => value.trim().length > 0 || "acceptance must be nonblank"),
    Schema.isMaxLength(8_192),
  ),
  budget: DelegationBudgetInput,
  depth: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(16)),
  ),
  parentDelegationId: Schema.optional(WorkjetDelegationId),
  ttlSeconds: Schema.optional(TtlSeconds),
});

// ===============================
// Bounded result schemas
// ===============================

const DeliveryStatus = Schema.Literals(["acknowledged", "queued"]);

export const WorkjetSendMessageResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: DeliveryStatus,
  envelopeId: WorkjetEnvelopeId,
  disposition: Schema.optional(WorkjetDeliveryDisposition),
  acknowledgedAt: Schema.optional(WorkjetMailboxTimestamp),
});

export const WorkjetDelegateTaskResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: DeliveryStatus,
  envelopeId: WorkjetEnvelopeId,
  delegationId: WorkjetDelegationId,
  ownerEnvironmentId: EnvironmentId,
  ownerThreadId: ThreadId,
  state: WorkjetDelegationState,
  disposition: Schema.optional(WorkjetDeliveryDisposition),
  acknowledgedAt: Schema.optional(WorkjetMailboxTimestamp),
});

const decodeSendMessageInputSchema = Schema.decodeUnknownEffect(WorkjetSendMessageInputSchema, {
  onExcessProperty: "error",
});

const decodeDelegateTaskInputSchema = Schema.decodeUnknownEffect(WorkjetDelegateTaskInputSchema, {
  onExcessProperty: "error",
});

export const decodeSendMessageInput = (payload: unknown) =>
  decodeSendMessageInputSchema(payload).pipe(
    Effect.mapError(
      () => new McpSchema.InvalidParams({ message: "Invalid Workjet mailbox message input." }),
    ),
  );

export const decodeDelegateTaskInput = (payload: unknown) =>
  decodeDelegateTaskInputSchema(payload).pipe(
    Effect.mapError(
      () => new McpSchema.InvalidParams({ message: "Invalid Workjet delegation input." }),
    ),
  );

// ===============================
// Tools
// ===============================

export const isMailboxToolVisible = (
  invocation: McpInvocationContext.McpInvocationScope,
): boolean => McpInvocationContext.isWorkjetOrchestrator(invocation);

const enabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return Option.isSome(invocation) && isMailboxToolVisible(invocation.value);
};

export const SendMessageMcpTool = Tool.make(WORKJET_SEND_MESSAGE_TOOL_NAME, {
  description:
    "Send an informational Workjet message to another worker thread through the durable mailbox. A target in this environment is delivered immediately and acknowledged with a delivery receipt; a target on another machine is stored as pending outbound and reported as queued.",
  parameters: WorkjetSendMessageInputSchema,
  success: WorkjetSendMessageResultSchema,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    WorkjetMailboxDelivery.WorkjetMailboxDelivery,
  ],
})
  .annotate(Tool.Title, "Send Workjet message")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, enabledWhen);

export const DelegateTaskMcpTool = Tool.make(WORKJET_DELEGATE_TASK_TOOL_NAME, {
  description:
    "Send a Workjet message plus task (a delegation) to another worker thread through the durable mailbox. The delegation carries an immutable prompt snapshot reference, an explicit file scope, a completion contract, and a budget, and owns a durable lifecycle starting at queued.",
  parameters: WorkjetDelegateTaskInputSchema,
  success: WorkjetDelegateTaskResultSchema,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    WorkjetMailboxDelivery.WorkjetMailboxDelivery,
  ],
})
  .annotate(Tool.Title, "Delegate Workjet task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, enabledWhen);

const failureResult = (reason: string): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: "WorkjetMailboxError",
        reason,
      },
    },
    content: [{ type: "text", text: "Workjet mailbox operation failed." }],
  });

const toolAnnotations = (tool: typeof SendMessageMcpTool | typeof DelegateTaskMcpTool) => ({
  ...Context.getOption(tool.annotations, Tool.Title).pipe(
    Option.map((title) => ({ title })),
    Option.getOrUndefined,
  ),
  readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
  destructiveHint: Context.get(tool.annotations, Tool.Destructive),
  idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
  openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
});

const successResult = (structuredContent: unknown): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: false,
    structuredContent,
    // @effect-diagnostics-next-line preferSchemaOverJson:off -- MCP text mirrors the validated structured result.
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  });

const registerSendMessage = Effect.fn("McpHttpServer.registerWorkjetSendMessage")(function* () {
  const server = yield* McpServer.McpServer;
  const delivery = yield* WorkjetMailboxDelivery.WorkjetMailboxDelivery;
  const tool = SendMessageMcpTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(WorkjetSendMessageResultSchema),
      annotations: toolAnnotations(tool),
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return Effect.gen(function* () {
          yield* McpInvocationContext.requireWorkjetOrchestrator();
          const input = yield* decodeSendMessageInput(payload);
          const body: WorkjetMessageBody =
            input.body._tag === "inline"
              ? { _tag: "inline", text: input.body.text }
              : {
                  _tag: "sealed",
                  payloadRef: input.body.payloadRef,
                  byteLength: input.body.byteLength,
                };
          const outcome = yield* delivery.sendMessage(invocation, {
            targetWorkspaceId: input.targetWorkspaceId,
            targetEnvironmentId: input.targetEnvironmentId,
            targetThreadId: input.targetThreadId,
            body,
            ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
            ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
          });
          return successResult(
            outcome._tag === "queued"
              ? {
                  schemaVersion: 1,
                  status: "queued",
                  envelopeId: outcome.envelopeId,
                }
              : {
                  schemaVersion: 1,
                  status: "acknowledged",
                  envelopeId: outcome.envelopeId,
                  disposition: outcome.receipt.disposition,
                  acknowledgedAt: outcome.receipt.acknowledgedAt,
                },
          );
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetOrchestratorUnavailableError: () =>
              Effect.succeed(failureResult("unauthorized")),
            WorkjetMailboxError: (error) => Effect.succeed(failureResult(error.reason)),
          }),
        );
      }),
  });
});

const registerDelegateTask = Effect.fn("McpHttpServer.registerWorkjetDelegateTask")(function* () {
  const server = yield* McpServer.McpServer;
  const delivery = yield* WorkjetMailboxDelivery.WorkjetMailboxDelivery;
  const tool = DelegateTaskMcpTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(WorkjetDelegateTaskResultSchema),
      annotations: toolAnnotations(tool),
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return Effect.gen(function* () {
          yield* McpInvocationContext.requireWorkjetOrchestrator();
          const input = yield* decodeDelegateTaskInput(payload);
          // A parent edge is owned by the delegating thread itself, so the
          // delivery service resolves its address from the environment's mesh
          // identity; nothing here invents a cross-workspace owner.
          const outcome = yield* delivery.delegateTask(invocation, {
            targetWorkspaceId: input.targetWorkspaceId,
            targetEnvironmentId: input.targetEnvironmentId,
            targetThreadId: input.targetThreadId,
            prompt: {
              schemaVersion: 1,
              snapshotRef: input.prompt.snapshotRef,
              digest: input.prompt.digest,
              byteLength: input.prompt.byteLength,
            },
            scope: {
              schemaVersion: 1,
              files: input.scope.files,
              nonGoals: input.scope.nonGoals,
            },
            completion: { schemaVersion: 1, acceptance: input.acceptance },
            budget: {
              maxDepth: input.budget.maxDepth,
              maxReviewRounds: input.budget.maxReviewRounds,
              ttlSeconds: input.budget.ttlSeconds,
            },
            ...(input.depth !== undefined ? { depth: input.depth } : {}),
            ...(input.parentDelegationId !== undefined
              ? { parentDelegationId: input.parentDelegationId }
              : {}),
            ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
          });
          const base = {
            schemaVersion: 1,
            envelopeId: outcome.delivery.envelopeId,
            delegationId: outcome.delegation.delegationId,
            ownerEnvironmentId: outcome.delegation.owner.environmentId,
            ownerThreadId: outcome.delegation.owner.threadId,
            state: outcome.state,
          } as const;
          return successResult(
            outcome.delivery._tag === "queued"
              ? { ...base, status: "queued" }
              : {
                  ...base,
                  status: "acknowledged",
                  disposition: outcome.delivery.receipt.disposition,
                  acknowledgedAt: outcome.delivery.receipt.acknowledgedAt,
                },
          );
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetOrchestratorUnavailableError: () =>
              Effect.succeed(failureResult("unauthorized")),
            WorkjetMailboxError: (error) => Effect.succeed(failureResult(error.reason)),
          }),
        );
      }),
  });
});

export const MailboxToolkitRegistrationLive = Layer.mergeAll(
  Layer.effectDiscard(registerSendMessage()),
  Layer.effectDiscard(registerDelegateTask()),
);
