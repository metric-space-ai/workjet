// @effect-diagnostics preferSchemaOverJson:off -- MCP text and immutable prompt snapshots mirror bounded validated structures.
import { parseWorkjetThreadDeepLink } from "@t3tools/shared/agentAwareness";
import {
  EnvironmentId,
  ThreadId,
  WorkjetDelegationId,
  WorkjetDelegationState,
  WorkjetEnvelopeId,
  WorkjetRepositoryPath,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as WorkjetMailboxDelivery from "../../../workjet/mailbox/WorkjetMailboxDelivery.ts";
import { WorkjetMeshIdentity } from "../../../workjet/mailbox/WorkjetMeshIdentity.ts";
import * as WorkjetSnapshotStore from "../../../workjet/mailbox/WorkjetSnapshotStore.ts";

export const WORKJET_CONTACT_MANAGER_TOOL_NAME = "workjet_contact_manager";

const BoundedText = (maximum: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => value.trim().length > 0 || "value must be nonblank"),
    Schema.isMaxLength(maximum),
  );

export const WorkjetContactManagerInput = Schema.Struct({
  kind: Schema.Literals(["bug", "access", "secret-operation", "bulletin", "blocker"]),
  subject: BoundedText(200),
  details: BoundedText(12_000),
  references: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(2_048))).check(Schema.isMaxLength(20)),
  ),
  secretHandle: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  urgency: Schema.optional(Schema.Literals(["normal", "high", "critical"])),
});

export const WorkjetContactManagerResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literals(["queued", "acknowledged"]),
  envelopeId: WorkjetEnvelopeId,
  delegationId: WorkjetDelegationId,
  state: WorkjetDelegationState,
  managerEnvironmentId: EnvironmentId,
  managerThreadId: ThreadId,
});

const enabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return Option.isSome(invocation) && McpInvocationContext.isWorkjetMember(invocation.value);
};

export const WorkjetContactManagerTool = Tool.make(WORKJET_CONTACT_MANAGER_TOOL_NAME, {
  description:
    "Send one structured, durable governance request to the configured Workjet Manager. Use secret handles only; never include plaintext secret values.",
  parameters: WorkjetContactManagerInput,
  success: WorkjetContactManagerResult,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ServerSettingsService,
    WorkjetMailboxDelivery.WorkjetMailboxDelivery,
    WorkjetMeshIdentity,
    WorkjetSnapshotStore.WorkjetSnapshotStore,
  ],
})
  .annotate(Tool.Title, "Contact Workjet Manager")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, enabledWhen);

const failureResult = (reason: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: { error: reason },
    content: [{ type: "text" as const, text: `Workjet Manager request failed: ${reason}.` }],
  });

const register = Effect.fn("McpHttpServer.registerWorkjetManager")(function* () {
  const server = yield* McpServer.McpServer;
  const tool = WorkjetContactManagerTool;

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(WorkjetContactManagerResult),
      annotations: {
        title: "Contact Workjet Manager",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return Effect.gen(function* () {
          const settings = yield* ServerSettingsService;
          const delivery = yield* WorkjetMailboxDelivery.WorkjetMailboxDelivery;
          const identity = yield* WorkjetMeshIdentity;
          const snapshots = yield* WorkjetSnapshotStore.WorkjetSnapshotStore;
          yield* McpInvocationContext.requireWorkjetMember();
          const input = yield* Schema.decodeUnknownEffect(WorkjetContactManagerInput, {
            onExcessProperty: "error",
          })(payload).pipe(
            Effect.mapError(
              () => new McpSchema.InvalidParams({ message: "Invalid Workjet Manager request." }),
            ),
          );
          const settingsSnapshot = yield* settings.getSettings.pipe(
            Effect.mapError(
              () => new McpSchema.InternalError({ message: "Workjet settings unavailable." }),
            ),
          );
          const manager = parseWorkjetThreadDeepLink(
            settingsSnapshot.workjet.managerThreadReference,
          );
          if (manager === null) return failureResult("manager-not-configured");
          if (
            manager.environmentId === invocation.environmentId &&
            manager.threadId === invocation.threadId
          ) {
            return failureResult("manager-self-target");
          }
          if (containsLikelyPlaintextSecret(input.details)) {
            return failureResult("plaintext-secret-refused-use-secret-handle");
          }
          const request = JSON.stringify({
            schemaVersion: 1,
            type: "workjet-manager-request",
            kind: input.kind,
            subject: input.subject.trim(),
            details: input.details.trim(),
            references: input.references ?? [],
            secretHandle: input.secretHandle?.trim() || null,
            urgency: input.urgency ?? "normal",
            source: {
              environmentId: invocation.environmentId,
              threadId: invocation.threadId,
              providerInstanceId: invocation.providerInstanceId,
            },
          });
          const prompt = [
            "You are the configured Workjet Manager. Triage and handle this durable Collective request.",
            "Use CTOX/Decision Hub for policy-gated bugs, access decisions, and secret operations. Never request or return plaintext secrets; operate on secret handles only.",
            "Record a concise bulletin/work-block entry when done and reply through the delegation channel with the outcome or exact blocker.",
            "",
            request,
          ].join("\n");
          const promptSnapshot = yield* snapshots
            .put(prompt)
            .pipe(
              Effect.mapError(
                () => new McpSchema.InternalError({ message: "Manager request snapshot failed." }),
              ),
            );
          const outcome = yield* delivery.delegateTask(invocation, {
            targetWorkspaceId: identity.workspaceId,
            targetEnvironmentId: manager.environmentId,
            targetThreadId: manager.threadId,
            prompt: {
              schemaVersion: 1,
              snapshotRef: promptSnapshot.snapshotRef,
              digest: promptSnapshot.digest,
              byteLength: promptSnapshot.byteLength,
            },
            scope: {
              schemaVersion: 1,
              files: [WorkjetRepositoryPath.make(".")],
              nonGoals:
                "Do not edit product code unless the request explicitly authorizes a bounded fix.",
            },
            completion: {
              schemaVersion: 1,
              acceptance:
                "Return a durable triage outcome, action receipt, or exact policy blocker.",
            },
            budget: {
              maxDepth: 1,
              maxReviewRounds: 0,
              ttlSeconds: WorkjetMailboxDelivery.WORKJET_MAILBOX_MAX_TTL_SECONDS,
            },
          });
          const result = {
            schemaVersion: 1 as const,
            status:
              outcome.delivery._tag === "queued" ? ("queued" as const) : ("acknowledged" as const),
            envelopeId: outcome.delivery.envelopeId,
            delegationId: outcome.delegation.delegationId,
            state: outcome.state,
            managerEnvironmentId: manager.environmentId,
            managerThreadId: manager.threadId,
          };
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetMemberUnavailableError: () => Effect.succeed(failureResult("unauthorized")),
            WorkjetMailboxError: (error) => Effect.succeed(failureResult(error.reason)),
          }),
        );
      }),
  });
});

export const ManagerToolkitRegistrationLive = Layer.effectDiscard(register());

export const containsLikelyPlaintextSecret = (value: string): boolean =>
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"']{8,}/i.test(
    value.replace(/\bctox-secret:\/\/[^\s]+/gi, ""),
  );
