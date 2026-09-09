import { WorkjetCtoxBusinessOsInput, WorkjetCtoxBusinessOsResult } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DecisionHubConnectionRegistry } from "../../../workjet/decisionHub/DecisionHubConnectionRegistry.ts";
import { makeCtoxMcpTransport } from "../../../workjet/ctox/CtoxMcpTransport.ts";
import { CtoxNativeRequests } from "../../../workjet/ctox/CtoxNativeRequests.ts";

export const CTOX_BUSINESS_OS_TOOL_NAME = "ctox_business_os";
export const isCtoxBusinessOsToolVisible = (scope: McpInvocationContext.McpInvocationScope) =>
  McpInvocationContext.hasActiveWorkjetMcpCapability(scope, "ctox-business-os") &&
  McpInvocationContext.isWorkjetMember(scope) &&
  scope.ctoxBusinessOsBinding !== undefined;

const enabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const scope = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return Option.isSome(scope) && isCtoxBusinessOsToolVisible(scope.value);
};

export const CtoxBusinessOsTool = Tool.make(CTOX_BUSINESS_OS_TOOL_NAME, {
  description:
    "Use the Business OS instance bound to this thread. Supply request.operation and its typed fields to inspect/edit app source, read required development rules, validate apps, delegate native CTOX app work or follow its result. No endpoint, credentials or actor override is accepted.",
  parameters: WorkjetCtoxBusinessOsInput,
  success: WorkjetCtoxBusinessOsResult,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "CTOX Business OS")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, enabledWhen);

const failureResult = (reason: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: { error: { _tag: "CtoxBusinessOsError", reason } },
    content: [{ type: "text", text: `CTOX Business OS: ${reason}` }],
  });
const decodeInput = Schema.decodeUnknownEffect(WorkjetCtoxBusinessOsInput, {
  onExcessProperty: "error",
});

const register = Effect.fn("mcp.registerCtoxBusinessOs")(function* () {
  const server = yield* McpServer.McpServer;
  const registry = yield* Effect.serviceOption(DecisionHubConnectionRegistry);
  const nativeRequests = yield* Effect.serviceOption(CtoxNativeRequests);
  const transport = makeCtoxMcpTransport(yield* HttpClient.HttpClient);
  const tool = CtoxBusinessOsTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(WorkjetCtoxBusinessOsResult),
      annotations: {
        title: "CTOX Business OS",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.gen(function* () {
        // addTool handlers receive their invocation context dynamically from
        // the HTTP session scope. Missing scope must deny before any network I/O.
        const invocation = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
        if (Option.isNone(invocation)) return failureResult("capability-not-granted");
        const scope = invocation.value;
        const binding = scope.ctoxBusinessOsBinding;
        if (!binding || !isCtoxBusinessOsToolVisible(scope))
          return failureResult("capability-not-granted");
        const input = yield* decodeInput(payload).pipe(
          Effect.mapError(
            () => new McpSchema.InvalidParams({ message: "Invalid CTOX Business OS operation." }),
          ),
        );
        const identity = (requestKey: string) => ({
          threadId: scope.threadId,
          connectionId: binding.connectionId,
          instanceId: binding.instanceId,
          requestKey,
        });
        if (input.request.operation === "get_delegation") {
          if (Option.isNone(nativeRequests))
            return failureResult("native-request-store-unavailable");
          const reference = yield* nativeRequests.value.get(
            identity(input.request.idempotency_key),
          );
          const output = { instanceId: binding.instanceId, result: reference };
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: output,
            content: [
              {
                type: "text",
                text: yield* Schema.encodeEffect(
                  Schema.fromJsonString(WorkjetCtoxBusinessOsResult),
                )(output).pipe(
                  Effect.mapError(
                    () =>
                      new McpSchema.InternalError({
                        message: "Cannot encode CTOX delegation reference.",
                      }),
                  ),
                ),
              },
            ],
          });
        }
        if (Option.isNone(registry)) return failureResult("connection-unavailable");
        const target = yield* registry.value.resolveReadyTarget(
          binding.connectionId,
          binding.instanceId,
        );
        const { operation, ...arguments_ } = input.request;
        const name =
          operation === "delegate_task" ? "business_os.execute_action" : `business_os.${operation}`;
        const requiresRetryContract =
          (input.request.operation === "create_app" ||
            input.request.operation === "modify_app" ||
            input.request.operation === "delegate_task") &&
          input.request.idempotency_key !== undefined;
        yield* transport.probe(
          target,
          [name],
          requiresRetryContract ? { [name]: ["idempotency_key"] } : {},
        );
        const nativeRequest =
          (input.request.operation === "create_app" ||
            input.request.operation === "modify_app" ||
            input.request.operation === "delegate_task") &&
          input.request.idempotency_key !== undefined
            ? { ...input.request, idempotency_key: input.request.idempotency_key }
            : undefined;
        const nativeArguments =
          operation === "delegate_task"
            ? { ...arguments_, action_id: "ctox.delegate_task" }
            : arguments_;
        let dispatchArguments: Readonly<Record<string, unknown>> = nativeArguments;
        if (nativeRequest) {
          if (Option.isNone(nativeRequests))
            return failureResult("native-request-store-unavailable");
          const remoteRequestKey = yield* nativeRequests.value.prepare(
            identity(nativeRequest.idempotency_key),
            nativeRequest,
            target,
          );
          dispatchArguments = { ...nativeArguments, idempotency_key: remoteRequestKey };
        }
        const timeout =
          operation === "validate_app" || operation === "smoke_app" || operation === "e2e_app"
            ? Duration.seconds(310)
            : Duration.seconds(10);
        const result = yield* transport.callTool(target, name, dispatchArguments, timeout);
        if (result.isError || result.structuredContent === undefined)
          return failureResult("ctox-operation-rejected");
        if (nativeRequest && Option.isSome(nativeRequests)) {
          yield* nativeRequests.value.recordReceipt(
            identity(nativeRequest.idempotency_key),
            result.structuredContent,
          );
        }
        const output = { instanceId: binding.instanceId, result: result.structuredContent };
        return new McpSchema.CallToolResult({
          isError: false,
          structuredContent: output,
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- MCP text mirrors structured content.
          content: [{ type: "text", text: JSON.stringify(output) }],
        });
      }).pipe(
        Effect.catchTags({
          CtoxNativeRequestError: (error) => Effect.succeed(failureResult(error.reason)),
          WorkjetDecisionHubConnectionError: (error) => Effect.succeed(failureResult(error.reason)),
          CtoxMcpTransportError: (error) => Effect.succeed(failureResult(error.reason)),
        }),
      ),
  });
});

export const CtoxBusinessOsToolkitRegistrationLive = Layer.effectDiscard(register());
