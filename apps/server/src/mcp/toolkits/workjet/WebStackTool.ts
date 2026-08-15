import {
  builtInCapabilityManifests,
  WEB_DEEP_RESEARCH_INPUT_SCHEMA,
  WEB_READ_INPUT_SCHEMA,
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

export const WEB_SEARCH_MCP_TOOL_NAME = "web_search";
export const WEB_READ_MCP_TOOL_NAME = "web_read";
export const WEB_DEEP_RESEARCH_MCP_TOOL_NAME = "web_deep_research";
export const WEB_BROWSER_PREPARE_MCP_TOOL_NAME = "web_browser_prepare";
export const WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME = "web_browser_automate";

const webSearchManifest = builtInCapabilityManifests.find(
  (manifest) =>
    manifest.id === "web-search" &&
    manifest.version === "1.0.0" &&
    manifest.supportedAdapters.includes("t3-mcp"),
);
const webBrowserManifest = builtInCapabilityManifests.find(
  (manifest) =>
    manifest.id === "web-stack-browser" &&
    manifest.version === "1.0.0" &&
    manifest.supportedAdapters.includes("t3-mcp"),
);

if (!webSearchManifest) {
  throw new Error("The built-in Web Search t3-mcp manifest is unavailable.");
}
if (!webBrowserManifest) {
  throw new Error("The built-in Web Stack Browser t3-mcp manifest is unavailable.");
}

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

const annotations = (input: {
  readonly title: string;
  readonly readonly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly capabilityId: "web-search" | "web-stack-browser";
}) =>
  Context.make(Tool.Title, input.title).pipe(
    Context.add(Tool.Readonly, input.readonly),
    Context.add(Tool.Destructive, input.destructive),
    Context.add(Tool.Idempotent, input.idempotent),
    Context.add(Tool.OpenWorld, true),
    Context.add(McpSchema.EnabledWhen, enabledWhen(input.capabilityId)),
  );

const webSearchAnnotations = annotations({
  title: webSearchManifest.metadata.displayName,
  readonly: true,
  destructive: false,
  idempotent: true,
  capabilityId: "web-search",
});
const webReadAnnotations = annotations({
  title: "Read Web Page",
  readonly: true,
  destructive: false,
  idempotent: true,
  capabilityId: "web-search",
});
const webDeepResearchAnnotations = annotations({
  title: "Deep Web Research",
  readonly: true,
  destructive: false,
  idempotent: false,
  capabilityId: "web-search",
});
const webBrowserPrepareAnnotations = annotations({
  title: "Prepare Web Browser",
  readonly: false,
  destructive: true,
  idempotent: true,
  capabilityId: "web-stack-browser",
});
const webBrowserAutomateAnnotations = annotations({
  title: webBrowserManifest.metadata.displayName,
  readonly: false,
  destructive: true,
  idempotent: false,
  capabilityId: "web-stack-browser",
});

export const WebSearchMcpTool = {
  name: WEB_SEARCH_MCP_TOOL_NAME,
  description: webSearchManifest.metadata.description,
  annotations: webSearchAnnotations,
} as const;

export const WebReadMcpTool = {
  name: WEB_READ_MCP_TOOL_NAME,
  description:
    "Reads one public web page through bounded evidence gates and returns normalized page evidence without local artifacts or raw bodies.",
  annotations: webReadAnnotations,
} as const;

export const WebDeepResearchMcpTool = {
  name: WEB_DEEP_RESEARCH_MCP_TOOL_NAME,
  description:
    "Performs bounded multi-source web research and returns verified source summaries, coverage, call counts, and a report scaffold.",
  annotations: webDeepResearchAnnotations,
} as const;

export const WebBrowserPrepareMcpTool = {
  name: WEB_BROWSER_PREPARE_MCP_TOOL_NAME,
  description:
    "Checks browser automation readiness and optionally installs the bounded reference dependency and browser.",
  annotations: webBrowserPrepareAnnotations,
} as const;

export const WebBrowserAutomateMcpTool = {
  name: WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME,
  description: webBrowserManifest.metadata.description,
  annotations: webBrowserAutomateAnnotations,
} as const;

export const isWebSearchToolVisible = (
  invocation: McpInvocationContext.McpInvocationScope,
): boolean => McpInvocationContext.hasActiveWorkjetMcpCapability(invocation, "web-search");

export const isWebBrowserToolVisible = (
  invocation: McpInvocationContext.McpInvocationScope,
): boolean => McpInvocationContext.hasActiveWorkjetMcpCapability(invocation, "web-stack-browser");

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
  Effect.logWarning("Web Search MCP call failed", { reason: error.reason }).pipe(
    Effect.as(safeSearchFailureResult(error.reason)),
  );

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
  Effect.logWarning("Web Browser MCP call failed", { tool, reason: error.reason }).pipe(
    Effect.as(safeBrowserFailureResult(tool, error.reason)),
  );

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
      inputSchema: webSearchManifest.inputSchema,
      outputSchema: webSearchManifest.outputSchema,
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
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability("web-search");
          const input = yield* decodeWebSearchInput(payload).pipe(
            Effect.mapError(
              () => new McpSchema.InvalidParams({ message: "Invalid Web Search input." }),
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
      inputSchema: WEB_READ_INPUT_SCHEMA,
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
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability("web-search");
          const input = WebStackResearch.decodeWebReadInput(payload);
          if (!input) {
            return yield* new McpSchema.InvalidParams({ message: "Invalid Web Read input." });
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
      inputSchema: WEB_DEEP_RESEARCH_INPUT_SCHEMA,
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
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability("web-search");
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

const BROWSER_PREPARE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    installReference: { type: "boolean" },
    installBrowser: { type: "boolean" },
  },
} as const;

const BROWSER_PREPARE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "ready",
    "dependencyInstalled",
    "browserInstalled",
    "installAttempted",
    "dependencyInstallRan",
    "browserInstallRan",
    "reason",
  ],
  properties: {
    ready: { type: "boolean" },
    dependencyInstalled: { type: "boolean" },
    browserInstalled: { type: "boolean" },
    installAttempted: { type: "boolean" },
    dependencyInstallRan: { type: "boolean" },
    browserInstallRan: { type: "boolean" },
    reason: {
      type: "string",
      enum: ["ready", "runtime-unavailable", "dependency-missing", "browser-missing", "not-ready"],
    },
  },
} as const;

const registerWebBrowser = Effect.fn("McpHttpServer.registerWebBrowser")(function* () {
  const server = yield* McpServer.McpServer;
  const browser = yield* WebStackBrowser.WebStackBrowser;

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: WebBrowserPrepareMcpTool.name,
      description: WebBrowserPrepareMcpTool.description,
      inputSchema: BROWSER_PREPARE_INPUT_SCHEMA,
      outputSchema: BROWSER_PREPARE_OUTPUT_SCHEMA,
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
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability("web-stack-browser");
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
      inputSchema: webBrowserManifest.inputSchema,
      outputSchema: webBrowserManifest.outputSchema,
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
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability("web-stack-browser");
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
