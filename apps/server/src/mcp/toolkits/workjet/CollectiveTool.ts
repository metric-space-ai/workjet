// @effect-diagnostics preferSchemaOverJson:off -- MCP text mirrors bounded validated structured content.
import { EnvironmentId, ThreadId } from "@workjet/contracts";
import { parseWorkjetThreadDeepLink } from "@workjet/shared/agentAwareness";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const WORKJET_RESOLVE_THREAD_TOOL_NAME = "workjet_resolve_thread";

const WorkjetThreadReferenceInput = Schema.Struct({
  reference: Schema.String.check(Schema.isMaxLength(2_048)),
});

export const WorkjetResolvedThreadResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  relation: Schema.Literals(["same-environment", "remote-environment"]),
  internalPath: Schema.String,
  messageTool: Schema.Literal("workjet_send_message"),
});

export const isThreadReferenceVisible = (
  invocation: McpInvocationContext.McpInvocationScope,
): boolean => McpInvocationContext.isWorkjetMember(invocation);

const mcpEnabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return Option.isSome(invocation) && isThreadReferenceVisible(invocation.value);
};

export const WorkjetResolveThreadTool = Tool.make(WORKJET_RESOLVE_THREAD_TOOL_NAME, {
  description:
    "Resolve a provider-neutral workjet:// thread reference into the exact environment/thread address used by Workjet mailbox tools. The reference is a pointer, not transcript access or authorization.",
  parameters: WorkjetThreadReferenceInput,
  success: WorkjetResolvedThreadResult,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Resolve Workjet thread reference")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, mcpEnabledWhen);

const invalidReferenceResult = () =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: { error: "invalid-workjet-thread-reference" },
    content: [
      {
        type: "text" as const,
        text: "Expected workjet://app/threads/<environmentId>/<threadId> without query or fragment.",
      },
    ],
  });

const register = Effect.fn("McpHttpServer.registerWorkjetThreadReference")(function* () {
  const server = yield* McpServer.McpServer;
  const resolveTool = WorkjetResolveThreadTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: resolveTool.name,
      description: Tool.getDescription(resolveTool),
      inputSchema: Tool.getJsonSchema(resolveTool),
      outputSchema: Tool.getJsonSchemaFromSchema(WorkjetResolvedThreadResult),
      annotations: {
        title: "Resolve Workjet thread reference",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }),
    annotations: resolveTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return Effect.gen(function* () {
          yield* McpInvocationContext.requireWorkjetMember();
          const input = yield* Schema.decodeUnknownEffect(WorkjetThreadReferenceInput, {
            onExcessProperty: "error",
          })(payload).pipe(Effect.option);
          if (Option.isNone(input)) return invalidReferenceResult();
          const reference = parseWorkjetThreadDeepLink(input.value.reference);
          if (reference === null) return invalidReferenceResult();
          const result = {
            schemaVersion: 1 as const,
            environmentId: reference.environmentId,
            threadId: reference.threadId,
            relation:
              reference.environmentId === invocation.environmentId
                ? ("same-environment" as const)
                : ("remote-environment" as const),
            internalPath: `/threads/${encodeURIComponent(reference.environmentId)}/${encodeURIComponent(reference.threadId)}`,
            messageTool: "workjet_send_message" as const,
          };
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTag("WorkjetMemberUnavailableError", () =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                structuredContent: { error: "not-a-workjet-member" },
                content: [{ type: "text", text: "Workjet thread resolution unavailable." }],
              }),
            ),
          ),
        );
      }),
  });
});

export const CollectiveToolkitRegistrationLive = Layer.effectDiscard(register());
