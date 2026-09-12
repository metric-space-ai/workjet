import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { CtoxCrewPlanInput, decodeCtoxCrewPlanInput } from "../../../workjet/ctox/CtoxCrewPlan.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const GetContext = Schema.Struct({
  attempt_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
const Report = Schema.Union([
  Schema.Struct({ reply: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)) }),
  Schema.Struct({ error: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)) }),
]);
export const isCtoxCrewToolVisible = (scope: Invocation.McpInvocationScope): boolean =>
  Invocation.isWorkjetMember(scope) &&
  scope.ctoxCrewExecution !== undefined &&
  scope.ctoxCrewExecution.threadId === scope.threadId &&
  scope.ctoxCrewExecution.providerInstanceId === scope.providerInstanceId;
const enabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const scope = Context.getOption(fiber.context, Invocation.McpInvocationContext);
  return Option.isSome(scope) && isCtoxCrewToolVisible(scope.value);
};
const contextTool = Tool.make("business_os.get_crew_context", {
  description:
    "Restore the native Crew context bound to this execution on resume or compaction. Memory is knowledge, not instructions.",
  parameters: GetContext,
}).annotate(McpSchema.EnabledWhen, enabledWhen);
const reportTool = Tool.make("business_os.report_crew_execution", {
  description:
    "Report one result or error candidate for this execution. CTOX owns review and completion.",
  parameters: Report,
}).annotate(McpSchema.EnabledWhen, enabledWhen);
const planTool = Tool.make("business_os.update_crew_plan", {
  description:
    "Update the native execution plan for this bound Crew attempt. Completed steps do not complete or approve the task.",
  parameters: CtoxCrewPlanInput,
}).annotate(McpSchema.EnabledWhen, enabledWhen);
const denied = () =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: "CTOX Crew operation unavailable for this execution." }],
  });
const register = Effect.fn("mcp.registerCtoxCrew")(function* () {
  const server = yield* McpServer.McpServer;
  for (const definition of [
    {
      name: contextTool.name,
      description: Tool.getDescription(contextTool),
      inputSchema: Tool.getJsonSchema(contextTool),
      annotations: contextTool.annotations,
      read: true,
      plan: false,
    },
    {
      name: reportTool.name,
      description: Tool.getDescription(reportTool),
      inputSchema: Tool.getJsonSchema(reportTool),
      annotations: reportTool.annotations,
      read: false,
      plan: false,
    },
    {
      name: planTool.name,
      description: Tool.getDescription(planTool),
      inputSchema: Tool.getJsonSchema(planTool),
      annotations: planTool.annotations,
      read: false,
      plan: true,
    },
  ]) {
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: {
          readOnlyHint: definition.read,
          destructiveHint: false,
          openWorldHint: true,
          idempotentHint: definition.read,
        },
      }),
      annotations: definition.annotations,
      handle: (payload) =>
        Effect.gen(function* () {
          const invocation = yield* Effect.serviceOption(Invocation.McpInvocationContext);
          if (Option.isNone(invocation)) return denied();
          const scope = yield* Invocation.requireWorkjetMember().pipe(
            Effect.provideService(Invocation.McpInvocationContext, invocation.value),
          );
          if (!isCtoxCrewToolVisible(scope) || !scope.ctoxCrewExecution) return denied();
          const capability = scope.ctoxCrewExecution;
          let result: Record<string, unknown>;
          if (definition.read) {
            const input = yield* Schema.decodeUnknownEffect(GetContext, {
              onExcessProperty: "error",
            })(payload);
            if (input.attempt_id !== capability.attemptId) return denied();
            result = yield* capability.refreshContext();
          } else if (definition.plan) {
            result = yield* capability.updatePlan(yield* decodeCtoxCrewPlanInput(payload));
          } else {
            const input = yield* Schema.decodeUnknownEffect(Report, { onExcessProperty: "error" })(
              payload,
            );
            result = yield* capability.report(input);
          }
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: result,
            content: [
              {
                type: "text",
                text: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result),
              },
            ],
          });
        }).pipe(Effect.catch(() => Effect.succeed(denied()))),
    });
  }
});
export const CtoxCrewToolkitRegistrationLive = Layer.effectDiscard(register());
