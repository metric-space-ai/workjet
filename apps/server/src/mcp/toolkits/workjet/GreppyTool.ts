import { builtInCapabilityManifests } from "@metric-space-ai/workjet-capabilities";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as GreppySearch from "./GreppySearch.ts";

export const GREPPY_MCP_TOOL_NAME = "greppy_search";

const greppyManifest = builtInCapabilityManifests.find(
  (manifest) => manifest.id === "greppy" && manifest.supportedAdapters.includes("t3-mcp"),
);

if (!greppyManifest) {
  throw new Error("The built-in Greppy t3-mcp manifest is unavailable.");
}

const GreppySearchInput = Schema.Struct({
  task: Schema.String.check(Schema.isNonEmpty(), Schema.isMinLength(1), Schema.isMaxLength(4_000)),
});
const decodeGreppySearchInput = Schema.decodeUnknownEffect(GreppySearchInput);

const greppyEnabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return Option.isSome(invocation) && isGreppyToolVisible(invocation.value);
};

const greppyAnnotations = Context.make(Tool.Title, greppyManifest.metadata.displayName).pipe(
  Context.add(Tool.Readonly, true),
  Context.add(Tool.Destructive, false),
  Context.add(Tool.Idempotent, true),
  Context.add(Tool.OpenWorld, false),
  Context.add(McpSchema.EnabledWhen, greppyEnabledWhen),
);

export const GreppyMcpTool = {
  name: GREPPY_MCP_TOOL_NAME,
  description: greppyManifest.metadata.description,
  annotations: greppyAnnotations,
} as const;

export const isGreppyToolVisible = (invocation: McpInvocationContext.McpInvocationScope): boolean =>
  McpInvocationContext.hasActiveWorkjetMcpCapability(invocation, "greppy") &&
  McpInvocationContext.readMcpSessionCwd(invocation) !== undefined;

const safeFailureResult = (input: {
  readonly reason:
    | GreppySearch.GreppySearchFailureReason
    | "capability-not-granted"
    | "session-cwd-unavailable";
  readonly message: string;
}): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: "GreppyMcpSearchError",
        reason: input.reason,
      },
    },
    content: [{ type: "text", text: input.message }],
  });

const invocationFailureResult = (
  error:
    | McpInvocationContext.WorkjetMcpCapabilityUnavailableError
    | McpInvocationContext.McpSessionCwdUnavailableError,
): McpSchema.CallToolResult =>
  error._tag === "WorkjetMcpCapabilityUnavailableError"
    ? safeFailureResult({ reason: "capability-not-granted", message: error.message })
    : safeFailureResult({ reason: "session-cwd-unavailable", message: error.message });

const greppyFailureResult = (
  error: GreppySearch.GreppySearchError,
): Effect.Effect<McpSchema.CallToolResult> =>
  Effect.logWarning("Greppy MCP search failed", { reason: error.reason }).pipe(
    Effect.as(safeFailureResult({ reason: error.reason, message: error.message })),
  );

const registerGreppySearch = Effect.fn("McpHttpServer.registerGreppySearch")(function* () {
  const server = yield* McpServer.McpServer;
  const greppy = yield* GreppySearch.GreppySearch;
  const tool = GreppyMcpTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: tool.description,
      inputSchema: greppyManifest.inputSchema,
      outputSchema: greppyManifest.outputSchema,
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
          yield* McpInvocationContext.requireActiveWorkjetMcpCapability("greppy");
          const cwd = yield* McpInvocationContext.requireMcpSessionCwd();
          const input = yield* decodeGreppySearchInput(payload).pipe(
            Effect.mapError(
              () => new McpSchema.InvalidParams({ message: "Invalid Greppy search input." }),
            ),
          );
          const result = yield* greppy.search({ cwd, task: input.task });
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetMcpCapabilityUnavailableError: (error) =>
              Effect.succeed(invocationFailureResult(error)),
            McpSessionCwdUnavailableError: (error) =>
              Effect.succeed(invocationFailureResult(error)),
            GreppySearchError: greppyFailureResult,
          }),
        );
      }),
  });
});

export const WorkjetToolkitRegistrationLive = Layer.effectDiscard(registerGreppySearch());
