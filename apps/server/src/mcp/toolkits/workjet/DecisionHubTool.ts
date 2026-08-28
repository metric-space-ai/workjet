import {
  WorkjetDecisionHubEscalationInput,
  WorkjetDecisionHubEscalationResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DecisionHubEscalationService } from "../../../workjet/decisionHub/DecisionHubEscalationService.ts";

export const DECISION_HUB_ESCALATE_TOOL_NAME = "decision_hub_escalate";

const decodeInput = Schema.decodeUnknownEffect(WorkjetDecisionHubEscalationInput, {
  onExcessProperty: "error",
});

export const isDecisionHubToolVisible = (
  invocation: McpInvocationContext.McpInvocationScope,
): boolean =>
  McpInvocationContext.hasActiveWorkjetMcpCapability(invocation, "decision-hub") &&
  (invocation.workjetRole === "standard" || invocation.workjetRole === "orchestrator") &&
  invocation.decisionHubConnectionId !== undefined;

const mcpEnabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return Option.isSome(invocation) && isDecisionHubToolVisible(invocation.value);
};

export const DecisionHubEscalateTool = Tool.make(DECISION_HUB_ESCALATE_TOOL_NAME, {
  description:
    "Escalate one genuinely blocking owner decision through the configured Decision Hub, then stop this turn and wait for Workjet to resume it.",
  parameters: WorkjetDecisionHubEscalationInput,
  success: WorkjetDecisionHubEscalationResult,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Escalate owner decision")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, mcpEnabledWhen);

const failureResult = (reason: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: { error: { _tag: "DecisionHubEscalationError", reason } },
    content: [{ type: "text", text: "Decision Hub escalation failed." }],
  });

const register = Effect.fn("McpHttpServer.registerDecisionHubEscalation")(function* () {
  const server = yield* McpServer.McpServer;
  const escalation = yield* Effect.serviceOption(DecisionHubEscalationService);
  const tool = DecisionHubEscalateTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(WorkjetDecisionHubEscalationResult),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability("decision-hub");
          if (
            !isDecisionHubToolVisible(invocation) ||
            invocation.decisionHubConnectionId === undefined
          ) {
            return failureResult("capability-not-granted");
          }
          if (Option.isNone(escalation)) return failureResult("connection-unavailable");
          const input = yield* decodeInput(payload).pipe(
            Effect.mapError(
              () =>
                new McpSchema.InvalidParams({ message: "Invalid Decision Hub escalation input." }),
            ),
          );
          const result = yield* escalation.value.escalate(
            invocation,
            invocation.decisionHubConnectionId,
            input,
          );
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: result,
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- MCP text mirrors validated structured content.
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetMcpCapabilityUnavailableError: () =>
              Effect.succeed(failureResult("capability-not-granted")),
            WorkjetDecisionHubConnectionError: (error) =>
              Effect.succeed(failureResult(error.reason)),
          }),
        );
      }),
  });
});

export const DecisionHubToolkitRegistrationLive = Layer.effectDiscard(register());
