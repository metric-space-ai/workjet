import {
  EnvironmentId,
  ThreadId,
  WorkjetDelegationId,
  WorkjetEnvelopeId,
  WorkjetMeshWorkspaceId,
  WorkjetPayloadByteLength,
  WorkjetRepositoryPath,
  WorkjetSealedPayloadRef,
  WorkjetDelegationEdgeKind,
  WorkjetDelegationState,
  WorkjetDeliveryDisposition,
  WorkjetMailboxTimestamp,
  WorkjetReviewDecision,
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
import * as WorkjetSnapshotStore from "../../../workjet/mailbox/WorkjetSnapshotStore.ts";

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
export const WORKJET_REPLY_TOOL_NAME = "workjet_reply";
export const WORKJET_REQUEST_REVIEW_TOOL_NAME = "workjet_request_review";
export const WORKJET_UPDATE_DELEGATION_TOOL_NAME = "workjet_update_delegation";

/**
 * Review rounds are 1-based on the wire: a delegation with `maxReviewRounds: N`
 * admits rounds 1..N, and round `N + 1` is the loop-gate refusal. The bound
 * mirrors {@link WorkjetDelegationBudget}'s `0..16` ceiling on `maxReviewRounds`.
 */
const ReviewRound = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(16),
);

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

/**
 * Ceiling on the delegation prompt TEXT, in UTF-16 code units.
 *
 * 256 KiB is a deliberate order of magnitude below the contract's 8 MiB
 * payload ceiling: a delegation brief is prose plus a file whitelist, not a
 * transcript, and the snapshot store's byte ceiling is a backstop rather than
 * a budget. The gap also absorbs the units mismatch — `isMaxLength` counts
 * UTF-16 code units while the store counts UTF-8 BYTES, so a worst-case
 * all-multi-byte prompt of this length still encodes to well under 1 MiB and
 * can never reach the store's hard limit.
 */
export const WORKJET_DELEGATE_PROMPT_MAX_LENGTH = 262_144;

/**
 * The prompt arrives as TEXT, not as a caller-asserted snapshot reference.
 *
 * The delegation contract pins a prompt by digest, and a digest is only worth
 * anything if the side that stores the bytes is the side that computes it.
 * Accepting `snapshotRef`/`digest`/`byteLength` from the harness meant the
 * server pinned whatever it was told; now it stores the prompt through
 * {@link WorkjetSnapshotStore.WorkjetSnapshotStore} and derives all three
 * fields from the bytes it actually wrote.
 */
const PromptTextInput = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0 || "prompt must be nonblank"),
  Schema.isMaxLength(WORKJET_DELEGATE_PROMPT_MAX_LENGTH),
);

export const WorkjetDelegateTaskInputSchema = Schema.Struct({
  ...TargetAddressFields,
  prompt: PromptTextInput,
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
// Reply / review / update input schemas
// ===============================

export const WorkjetReplyInputSchema = Schema.Struct({
  ...TargetAddressFields,
  delegationId: WorkjetDelegationId,
  body: MessageBodyInput,
  ttlSeconds: Schema.optional(TtlSeconds),
});

export const WorkjetRequestReviewInputSchema = Schema.Struct({
  ...TargetAddressFields,
  delegationId: WorkjetDelegationId,
  round: ReviewRound,
  body: MessageBodyInput,
  ttlSeconds: Schema.optional(TtlSeconds),
});

/**
 * The bounded state operations. `cancel`, `revise`, and `follow-up` carry no
 * further fields; a `review` carries the verdict decision, its 1-based round,
 * and bounded reasons, mirroring {@link WorkjetReviewVerdict}.
 */
const DelegationUpdateInput = Schema.Union([
  Schema.TaggedStruct("cancel", {}),
  Schema.TaggedStruct("review", {
    decision: WorkjetReviewDecision,
    round: ReviewRound,
    reasons: Schema.optional(
      Schema.Array(
        Schema.String.check(
          Schema.makeFilter((value) => value.trim().length > 0 || "reason must be nonblank"),
          Schema.isMaxLength(1_024),
        ),
      ).check(Schema.isMaxLength(32)),
    ),
  }),
  Schema.TaggedStruct("revise", {}),
  Schema.TaggedStruct("follow-up", {}),
]);

export const WorkjetUpdateDelegationInputSchema = Schema.Struct({
  delegationId: WorkjetDelegationId,
  update: DelegationUpdateInput,
});

export const WorkjetReplyResultSchema = WorkjetSendMessageResultSchema;

export const WorkjetRequestReviewResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: DeliveryStatus,
  envelopeId: WorkjetEnvelopeId,
  delegationId: WorkjetDelegationId,
  state: WorkjetDelegationState,
  edgeKind: Schema.Literal("reviews"),
  disposition: Schema.optional(WorkjetDeliveryDisposition),
  acknowledgedAt: Schema.optional(WorkjetMailboxTimestamp),
});

export const WorkjetUpdateDelegationResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  delegationId: WorkjetDelegationId,
  state: WorkjetDelegationState,
  edgeKind: Schema.optional(WorkjetDelegationEdgeKind),
});

const decodeReplyInputSchema = Schema.decodeUnknownEffect(WorkjetReplyInputSchema, {
  onExcessProperty: "error",
});
const decodeRequestReviewInputSchema = Schema.decodeUnknownEffect(WorkjetRequestReviewInputSchema, {
  onExcessProperty: "error",
});
const decodeUpdateDelegationInputSchema = Schema.decodeUnknownEffect(
  WorkjetUpdateDelegationInputSchema,
  { onExcessProperty: "error" },
);

export const decodeReplyInput = (payload: unknown) =>
  decodeReplyInputSchema(payload).pipe(
    Effect.mapError(() => new McpSchema.InvalidParams({ message: "Invalid Workjet reply input." })),
  );

export const decodeRequestReviewInput = (payload: unknown) =>
  decodeRequestReviewInputSchema(payload).pipe(
    Effect.mapError(
      () => new McpSchema.InvalidParams({ message: "Invalid Workjet review-request input." }),
    ),
  );

export const decodeUpdateDelegationInput = (payload: unknown) =>
  decodeUpdateDelegationInputSchema(payload).pipe(
    Effect.mapError(
      () => new McpSchema.InvalidParams({ message: "Invalid Workjet delegation-update input." }),
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
    "Send a Workjet message plus task (a delegation) to another worker thread through the durable mailbox. The prompt text is stored as an immutable, content-addressed snapshot and the delegation carries its verified digest, alongside an explicit file scope, a completion contract, and a budget, and owns a durable lifecycle starting at queued.",
  parameters: WorkjetDelegateTaskInputSchema,
  success: WorkjetDelegateTaskResultSchema,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    WorkjetMailboxDelivery.WorkjetMailboxDelivery,
    WorkjetSnapshotStore.WorkjetSnapshotStore,
  ],
})
  .annotate(Tool.Title, "Delegate Workjet task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, enabledWhen);

export const ReplyMcpTool = Tool.make(WORKJET_REPLY_TOOL_NAME, {
  description:
    "Send a plain informational reply on an existing Workjet delegation thread. It references the delegation's envelope and carries no task, so it never changes the delegation lifecycle; delivery obeys the same durable contract as any Workjet message.",
  parameters: WorkjetReplyInputSchema,
  success: WorkjetReplyResultSchema,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    WorkjetMailboxDelivery.WorkjetMailboxDelivery,
  ],
})
  .annotate(Tool.Title, "Reply on Workjet delegation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, enabledWhen);

export const RequestReviewMcpTool = Tool.make(WORKJET_REQUEST_REVIEW_TOOL_NAME, {
  description:
    "Request review of a running Workjet delegation: it moves the delegation to review-requested, records a typed `reviews` edge in the delegation graph, and delivers a review-request signal to the reviewer. A review round beyond the delegation's maxReviewRounds budget is refused.",
  parameters: WorkjetRequestReviewInputSchema,
  success: WorkjetRequestReviewResultSchema,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    WorkjetMailboxDelivery.WorkjetMailboxDelivery,
  ],
})
  .annotate(Tool.Title, "Request Workjet review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, enabledWhen);

export const UpdateDelegationMcpTool = Tool.make(WORKJET_UPDATE_DELEGATION_TOOL_NAME, {
  description:
    "Advance an existing Workjet delegation through a bounded state operation: cancel it, submit a review verdict (approve completes it, changes-requested sends it back), record a revise re-run, or record a follow-up. Each maps to one enforced lifecycle transition and, where it creates a relationship, one typed delegation-graph edge; a revise or follow-up beyond the maxDepth budget is refused.",
  parameters: WorkjetUpdateDelegationInputSchema,
  success: WorkjetUpdateDelegationResultSchema,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    WorkjetMailboxDelivery.WorkjetMailboxDelivery,
  ],
})
  .annotate(Tool.Title, "Update Workjet delegation")
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

const toolAnnotations = (
  tool:
    | typeof SendMessageMcpTool
    | typeof DelegateTaskMcpTool
    | typeof ReplyMcpTool
    | typeof RequestReviewMcpTool
    | typeof UpdateDelegationMcpTool,
) => ({
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
    // MCP text mirrors the validated structured result.
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
  const snapshots = yield* WorkjetSnapshotStore.WorkjetSnapshotStore;
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
          // The snapshot is written BEFORE the delegation is created, so the
          // digest on the delegation always describes bytes that already exist
          // on disk. The store is content-addressed and immutable, so a retry
          // of a failed delegation re-derives the identical reference instead
          // of accumulating duplicates.
          const snapshot = yield* snapshots.put(input.prompt);
          // A parent edge is owned by the delegating thread itself, so the
          // delivery service resolves its address from the environment's mesh
          // identity; nothing here invents a cross-workspace owner.
          const outcome = yield* delivery.delegateTask(invocation, {
            targetWorkspaceId: input.targetWorkspaceId,
            targetEnvironmentId: input.targetEnvironmentId,
            targetThreadId: input.targetThreadId,
            prompt: {
              schemaVersion: 1,
              snapshotRef: snapshot.snapshotRef,
              digest: snapshot.digest,
              byteLength: snapshot.byteLength,
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
            // Snapshot failures collapse onto the mailbox contract's bounded
            // reasons: the harness learns that the prompt was too large or
            // that the mailbox could not accept it, and never sees a path,
            // digest, or filesystem detail.
            WorkjetSnapshotTooLargeError: () => Effect.succeed(failureResult("payload-too-large")),
            WorkjetSnapshotNotFoundError: () =>
              Effect.succeed(failureResult("mailbox-unavailable")),
            WorkjetSnapshotCorruptError: () => Effect.succeed(failureResult("mailbox-unavailable")),
            WorkjetSnapshotIoError: () => Effect.succeed(failureResult("mailbox-unavailable")),
          }),
        );
      }),
  });
});

const messageBodyFrom = (
  body: (typeof WorkjetSendMessageInputSchema.Type)["body"],
): WorkjetMessageBody =>
  body._tag === "inline"
    ? { _tag: "inline", text: body.text }
    : { _tag: "sealed", payloadRef: body.payloadRef, byteLength: body.byteLength };

const registerReply = Effect.fn("McpHttpServer.registerWorkjetReply")(function* () {
  const server = yield* McpServer.McpServer;
  const delivery = yield* WorkjetMailboxDelivery.WorkjetMailboxDelivery;
  const tool = ReplyMcpTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(WorkjetReplyResultSchema),
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
          const input = yield* decodeReplyInput(payload);
          const outcome = yield* delivery.reply(invocation, {
            targetWorkspaceId: input.targetWorkspaceId,
            targetEnvironmentId: input.targetEnvironmentId,
            targetThreadId: input.targetThreadId,
            delegationId: input.delegationId,
            body: messageBodyFrom(input.body),
            ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
          });
          return successResult(
            outcome._tag === "queued"
              ? { schemaVersion: 1, status: "queued", envelopeId: outcome.envelopeId }
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

const registerRequestReview = Effect.fn("McpHttpServer.registerWorkjetRequestReview")(function* () {
  const server = yield* McpServer.McpServer;
  const delivery = yield* WorkjetMailboxDelivery.WorkjetMailboxDelivery;
  const tool = RequestReviewMcpTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(WorkjetRequestReviewResultSchema),
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
          const input = yield* decodeRequestReviewInput(payload);
          const outcome = yield* delivery.requestReview(invocation, {
            targetWorkspaceId: input.targetWorkspaceId,
            targetEnvironmentId: input.targetEnvironmentId,
            targetThreadId: input.targetThreadId,
            delegationId: input.delegationId,
            round: input.round,
            body: messageBodyFrom(input.body),
            ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
          });
          const base = {
            schemaVersion: 1,
            envelopeId: outcome.delivery.envelopeId,
            delegationId: outcome.delegation.delegationId,
            state: outcome.state,
            edgeKind: outcome.edgeKind,
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

const registerUpdateDelegation = Effect.fn("McpHttpServer.registerWorkjetUpdateDelegation")(
  function* () {
    const server = yield* McpServer.McpServer;
    const delivery = yield* WorkjetMailboxDelivery.WorkjetMailboxDelivery;
    const tool = UpdateDelegationMcpTool;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
        outputSchema: Tool.getJsonSchemaFromSchema(WorkjetUpdateDelegationResultSchema),
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
            const input = yield* decodeUpdateDelegationInput(payload);
            const update: WorkjetMailboxDelivery.WorkjetMailboxDelegationUpdate =
              input.update._tag === "review"
                ? {
                    _tag: "review",
                    decision: input.update.decision,
                    round: input.update.round,
                    ...(input.update.reasons !== undefined
                      ? { reasons: input.update.reasons }
                      : {}),
                  }
                : { _tag: input.update._tag };
            const outcome = yield* delivery.updateDelegation(invocation, {
              delegationId: input.delegationId,
              update,
            });
            return successResult({
              schemaVersion: 1,
              delegationId: outcome.delegationId,
              state: outcome.state,
              ...(outcome.edgeKind !== undefined ? { edgeKind: outcome.edgeKind } : {}),
            });
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
  },
);

export const MailboxToolkitRegistrationLive = Layer.mergeAll(
  Layer.effectDiscard(registerSendMessage()),
  Layer.effectDiscard(registerDelegateTask()),
  Layer.effectDiscard(registerReply()),
  Layer.effectDiscard(registerRequestReview()),
  Layer.effectDiscard(registerUpdateDelegation()),
);
