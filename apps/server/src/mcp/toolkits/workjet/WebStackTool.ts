import { builtInCapabilityManifests } from "@metric-space-ai/workjet-capabilities";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WebStackSearch from "./WebStackSearch.ts";

export const WEB_SEARCH_MCP_TOOL_NAME = "web_search";

const webSearchManifest = builtInCapabilityManifests.find(
  (manifest) =>
    manifest.id === "web-search" &&
    manifest.version === "1.0.0" &&
    manifest.supportedAdapters.includes("t3-mcp"),
);

if (!webSearchManifest) {
  throw new Error("The built-in Web Search t3-mcp manifest is unavailable.");
}

const WebSearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMinLength(1), Schema.isMaxLength(2_000)),
});
const decodeWebSearchInput = Schema.decodeUnknownEffect(WebSearchInput);

const webSearchEnabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return Option.isSome(invocation) && isWebSearchToolVisible(invocation.value);
};

const webSearchAnnotations = Context.make(Tool.Title, webSearchManifest.metadata.displayName).pipe(
  Context.add(Tool.Readonly, true),
  Context.add(Tool.Destructive, false),
  Context.add(Tool.Idempotent, true),
  Context.add(Tool.OpenWorld, true),
  Context.add(McpSchema.EnabledWhen, webSearchEnabledWhen),
);

export const WebSearchMcpTool = {
  name: WEB_SEARCH_MCP_TOOL_NAME,
  description: webSearchManifest.metadata.description,
  annotations: webSearchAnnotations,
} as const;

export const isWebSearchToolVisible = (
  invocation: McpInvocationContext.McpInvocationScope,
): boolean => McpInvocationContext.hasActiveWorkjetMcpCapability(invocation, "web-search");

const safeFailureResult = (
  reason: WebStackSearch.WebStackSearchFailureReason | "capability-not-granted",
): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: "WebStackMcpSearchError",
        reason,
      },
    },
    content: [{ type: "text", text: "Web Search failed." }],
  });

const webSearchFailureResult = (
  error: WebStackSearch.WebStackSearchError,
): Effect.Effect<McpSchema.CallToolResult> =>
  Effect.logWarning("Web Search MCP call failed", { reason: error.reason }).pipe(
    Effect.as(safeFailureResult(error.reason)),
  );

const registerWebSearch = Effect.fn("McpHttpServer.registerWebSearch")(function* () {
  const server = yield* McpServer.McpServer;
  const webSearch = yield* WebStackSearch.WebStackSearch;
  const tool = WebSearchMcpTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: tool.description,
      inputSchema: webSearchManifest.inputSchema,
      outputSchema: webSearchManifest.outputSchema,
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
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
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability("web-search");
          const input = yield* decodeWebSearchInput(payload).pipe(
            Effect.mapError(
              () => new McpSchema.InvalidParams({ message: "Invalid Web Search input." }),
            ),
          );
          const result = yield* webSearch.search({ query: input.query });
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetMcpCapabilityUnavailableError: () =>
              Effect.succeed(safeFailureResult("capability-not-granted")),
            WebStackSearchError: webSearchFailureResult,
          }),
        );
      }),
  });
});

export const WebStackToolkitRegistrationLive = Layer.effectDiscard(registerWebSearch());
