import {
  WEB_BROWSER_AUTOMATE_TOOL_CONTRACT,
  WEB_BROWSER_PREPARE_TOOL_CONTRACT,
  WEB_DEEP_RESEARCH_TOOL_CONTRACT,
  WEB_READ_TOOL_CONTRACT,
  WEB_SEARCH_TOOL_CONTRACT,
  type WebStackToolContract,
} from "@metric-space-ai/workjet-capabilities";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WebStackBrowser from "./WebStackBrowser.ts";
import * as WebStackResearch from "./WebStackResearch.ts";
import * as WebStackSearch from "./WebStackSearch.ts";

export const WEB_SEARCH_MCP_TOOL_NAME = WEB_SEARCH_TOOL_CONTRACT.name;
export const WEB_READ_MCP_TOOL_NAME = WEB_READ_TOOL_CONTRACT.name;
export const WEB_DEEP_RESEARCH_MCP_TOOL_NAME = WEB_DEEP_RESEARCH_TOOL_CONTRACT.name;
export const WEB_BROWSER_PREPARE_MCP_TOOL_NAME = WEB_BROWSER_PREPARE_TOOL_CONTRACT.name;
export const WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME = WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.name;

const WebSearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMinLength(1), Schema.isMaxLength(2_000)),
});
const decodeWebSearchInput = Schema.decodeUnknownEffect(WebSearchInput);

const enabledWhen = (capabilityId: "web-search" | "web-stack-browser") => () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return (
    Option.isSome(invocation) &&
    McpInvocationContext.hasActiveWorkjetMcpCapability(invocation.value, capabilityId)
  );
};

const annotations = (contract: WebStackToolContract) =>
  Context.make(Tool.Title, contract.annotations.title).pipe(
    Context.add(Tool.Readonly, contract.annotations.readOnlyHint),
    Context.add(Tool.Destructive, contract.annotations.destructiveHint),
    Context.add(Tool.Idempotent, contract.annotations.idempotentHint),
    Context.add(Tool.OpenWorld, contract.annotations.openWorldHint),
    Context.add(McpSchema.EnabledWhen, enabledWhen(contract.capabilityId)),
  );

const webSearchAnnotations = annotations(WEB_SEARCH_TOOL_CONTRACT);
const webReadAnnotations = annotations(WEB_READ_TOOL_CONTRACT);
const webDeepResearchAnnotations = annotations(WEB_DEEP_RESEARCH_TOOL_CONTRACT);
const webBrowserPrepareAnnotations = annotations(WEB_BROWSER_PREPARE_TOOL_CONTRACT);
const webBrowserAutomateAnnotations = annotations(WEB_BROWSER_AUTOMATE_TOOL_CONTRACT);

export const WebSearchMcpTool = {
  name: WEB_SEARCH_TOOL_CONTRACT.name,
  description: WEB_SEARCH_TOOL_CONTRACT.description,
  annotations: webSearchAnnotations,
} as const;

export const WebReadMcpTool = {
  name: WEB_READ_TOOL_CONTRACT.name,
  description: WEB_READ_TOOL_CONTRACT.description,
  annotations: webReadAnnotations,
} as const;

export const WebDeepResearchMcpTool = {
  name: WEB_DEEP_RESEARCH_TOOL_CONTRACT.name,
  description: WEB_DEEP_RESEARCH_TOOL_CONTRACT.description,
  annotations: webDeepResearchAnnotations,
} as const;

export const WebBrowserPrepareMcpTool = {
  name: WEB_BROWSER_PREPARE_TOOL_CONTRACT.name,
  description: WEB_BROWSER_PREPARE_TOOL_CONTRACT.description,
  annotations: webBrowserPrepareAnnotations,
} as const;

export const WebBrowserAutomateMcpTool = {
  name: WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.name,
  description: WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.description,
  annotations: webBrowserAutomateAnnotations,
} as const;

export const isWebSearchToolVisible = (
  invocation: McpInvocationContext.McpInvocationScope,
): boolean =>
  McpInvocationContext.hasActiveWorkjetMcpCapability(
    invocation,
    WEB_SEARCH_TOOL_CONTRACT.capabilityId,
  );

export const isWebBrowserToolVisible = (
  invocation: McpInvocationContext.McpInvocationScope,
): boolean =>
  McpInvocationContext.hasActiveWorkjetMcpCapability(
    invocation,
    WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.capabilityId,
  );

const toolAnnotations = (tool: {
  readonly annotations: Context.Context<McpSchema.EnabledWhen | Tool.Title>;
}) => ({
  ...Context.getOption(tool.annotations, Tool.Title).pipe(
    Option.map((title) => ({ title })),
    Option.getOrUndefined,
  ),
  readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
  destructiveHint: Context.get(tool.annotations, Tool.Destructive),
  idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
  openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
});

const safeSearchFailureResult = (
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

const safeResearchFailureResult = (
  operation: "read" | "deep-research",
  reason: WebStackResearch.WebStackResearchFailureReason | "capability-not-granted",
): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: "WebStackMcpResearchError",
        operation,
        reason,
      },
    },
    content: [{ type: "text", text: "Web research failed." }],
  });

const safeBrowserFailureResult = (
  tool: "prepare" | "automate",
  reason: WebStackBrowser.WebStackBrowserFailureReason | "capability-not-granted",
): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: "WebStackMcpBrowserError",
        tool,
        reason,
      },
    },
    content: [{ type: "text", text: "Web Browser failed." }],
  });

const webSearchFailureResult = (
  error: WebStackSearch.WebStackSearchError,
): Effect.Effect<McpSchema.CallToolResult> =>
  Effect.logWarning("Web Search MCP call failed", {
    reason: error.reason,
  }).pipe(Effect.as(safeSearchFailureResult(error.reason)));

const webResearchFailureResult = (
  operation: "read" | "deep-research",
  error: WebStackResearch.WebStackResearchError,
): Effect.Effect<McpSchema.CallToolResult> =>
  Effect.logWarning("Web research MCP call failed", {
    operation,
    reason: error.reason,
  }).pipe(Effect.as(safeResearchFailureResult(operation, error.reason)));

const webBrowserFailureResult = (
  tool: "prepare" | "automate",
  error: WebStackBrowser.WebStackBrowserError,
): Effect.Effect<McpSchema.CallToolResult> =>
  Effect.logWarning("Web Browser MCP call failed", {
    tool,
    reason: error.reason,
  }).pipe(Effect.as(safeBrowserFailureResult(tool, error.reason)));

const callResult = (result: unknown): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: false,
    structuredContent: result,
    content: [{ type: "text", text: JSON.stringify(result) }],
  });

const registerWebSearch = Effect.fn("McpHttpServer.registerWebSearch")(function* () {
  const server = yield* McpServer.McpServer;
  const webSearch = yield* WebStackSearch.WebStackSearch;
  const tool = WebSearchMcpTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: tool.description,
      inputSchema: WEB_SEARCH_TOOL_CONTRACT.inputSchema,
      outputSchema: WEB_SEARCH_TOOL_CONTRACT.outputSchema,
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
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability(
            WEB_SEARCH_TOOL_CONTRACT.capabilityId,
          );
          const input = yield* decodeWebSearchInput(payload).pipe(
            Effect.mapError(
              () =>
                new McpSchema.InvalidParams({
                  message: "Invalid Web Search input.",
                }),
            ),
          );
          return callResult(yield* webSearch.search({ query: input.query }));
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetMcpCapabilityUnavailableError: () =>
              Effect.succeed(safeSearchFailureResult("capability-not-granted")),
            WebStackSearchError: webSearchFailureResult,
          }),
        );
      }),
  });
});

const registerWebResearch = Effect.fn("McpHttpServer.registerWebResearch")(function* () {
  const server = yield* McpServer.McpServer;
  const research = yield* WebStackResearch.WebStackResearch;

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: WebReadMcpTool.name,
      description: WebReadMcpTool.description,
      inputSchema: WEB_READ_TOOL_CONTRACT.inputSchema,
      outputSchema: WEB_READ_TOOL_CONTRACT.outputSchema,
      annotations: toolAnnotations(WebReadMcpTool),
    }),
    annotations: WebReadMcpTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return Effect.gen(function* () {
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability(
            WEB_READ_TOOL_CONTRACT.capabilityId,
          );
          const input = WebStackResearch.decodeWebReadInput(payload);
          if (!input) {
            return yield* new McpSchema.InvalidParams({
              message: "Invalid Web Read input.",
            });
          }
          return callResult(yield* research.read(input));
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetMcpCapabilityUnavailableError: () =>
              Effect.succeed(safeResearchFailureResult("read", "capability-not-granted")),
            WebStackResearchError: (error) => webResearchFailureResult("read", error),
          }),
        );
      }),
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: WebDeepResearchMcpTool.name,
      description: WebDeepResearchMcpTool.description,
      inputSchema: WEB_DEEP_RESEARCH_TOOL_CONTRACT.inputSchema,
      outputSchema: WEB_DEEP_RESEARCH_TOOL_CONTRACT.outputSchema,
      annotations: toolAnnotations(WebDeepResearchMcpTool),
    }),
    annotations: WebDeepResearchMcpTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return Effect.gen(function* () {
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability(
            WEB_DEEP_RESEARCH_TOOL_CONTRACT.capabilityId,
          );
          const input = WebStackResearch.decodeWebDeepResearchInput(payload);
          if (!input) {
            return yield* new McpSchema.InvalidParams({
              message: "Invalid Web Deep Research input.",
            });
          }
          return callResult(yield* research.deepResearch(input));
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetMcpCapabilityUnavailableError: () =>
              Effect.succeed(safeResearchFailureResult("deep-research", "capability-not-granted")),
            WebStackResearchError: (error) => webResearchFailureResult("deep-research", error),
          }),
        );
      }),
  });
});

const registerWebBrowser = Effect.fn("McpHttpServer.registerWebBrowser")(function* () {
  const server = yield* McpServer.McpServer;
  const browser = yield* WebStackBrowser.WebStackBrowser;

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: WebBrowserPrepareMcpTool.name,
      description: WebBrowserPrepareMcpTool.description,
      inputSchema: WEB_BROWSER_PREPARE_TOOL_CONTRACT.inputSchema,
      outputSchema: WEB_BROWSER_PREPARE_TOOL_CONTRACT.outputSchema,
      annotations: toolAnnotations(WebBrowserPrepareMcpTool),
    }),
    annotations: WebBrowserPrepareMcpTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return Effect.gen(function* () {
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability(
            WEB_BROWSER_PREPARE_TOOL_CONTRACT.capabilityId,
          );
          const input = WebStackBrowser.decodeBrowserPrepareInput(payload);
          if (!input) {
            return yield* new McpSchema.InvalidParams({
              message: "Invalid Web Browser prepare input.",
            });
          }
          return callResult(yield* browser.prepare(input));
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetMcpCapabilityUnavailableError: () =>
              Effect.succeed(safeBrowserFailureResult("prepare", "capability-not-granted")),
            WebStackBrowserError: (error) => webBrowserFailureResult("prepare", error),
          }),
        );
      }),
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: WebBrowserAutomateMcpTool.name,
      description: WebBrowserAutomateMcpTool.description,
      inputSchema: WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.inputSchema,
      outputSchema: WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.outputSchema,
      annotations: toolAnnotations(WebBrowserAutomateMcpTool),
    }),
    annotations: WebBrowserAutomateMcpTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return Effect.gen(function* () {
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability(
            WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.capabilityId,
          );
          const input = WebStackBrowser.decodeBrowserAutomationInput(payload);
          if (!input) {
            return yield* new McpSchema.InvalidParams({
              message: "Invalid Web Browser automation input.",
            });
          }
          return callResult(yield* browser.automate(input));
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetMcpCapabilityUnavailableError: () =>
              Effect.succeed(safeBrowserFailureResult("automate", "capability-not-granted")),
            WebStackBrowserError: (error) => webBrowserFailureResult("automate", error),
          }),
        );
      }),
  });
});

export const WebStackToolkitRegistrationLive = Layer.effectDiscard(
  Effect.all([registerWebSearch(), registerWebResearch(), registerWebBrowser()], {
    concurrency: "unbounded",
  }),
);
