import { builtInCapabilityManifests } from "@metric-space-ai/workjet-capabilities";
import { expect, it, vi } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as GreppySearch from "./GreppySearch.ts";
import * as GreppyTool from "./GreppyTool.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {
      experimental: { greppy: true },
    },
    clientInfo: { name: "greppy-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation = (
  grants: ReadonlyArray<"greppy" | "web-search" | "web-stack-browser">,
  cwd?: string,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-greppy-test"),
  threadId: ThreadId.make("thread-greppy-test"),
  providerSessionId: "provider-session-greppy-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"]),
  activeWorkjetMcpCapabilityIds: new Set(grants),
  ...(cwd ? { cwd } : {}),
  issuedAt: 1,
});

function makeTestLayer(search: GreppySearch.GreppySearchShape) {
  return GreppyTool.WorkjetToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(GreppySearch.GreppySearch, GreppySearch.GreppySearch.of(search))),
  );
}

it.effect("registers only Greppy with the canonical built-in MCP schemas and annotations", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registered = server.tools.find(
      ({ tool }) => tool.name === GreppyTool.GREPPY_MCP_TOOL_NAME,
    );
    const manifest = builtInCapabilityManifests.find(({ id }) => id === "greppy");

    expect(registered).toBeDefined();
    expect(registered?.tool.inputSchema).toEqual(manifest?.inputSchema);
    expect(registered?.tool.outputSchema).toEqual(manifest?.outputSchema);
    expect(registered?.tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(server.tools.map(({ tool }) => tool.name)).not.toContain("web_search");
    expect(server.tools.map(({ tool }) => tool.name)).not.toContain("web_stack_browser");
  }).pipe(Effect.provide(makeTestLayer({ search: () => Effect.succeed({ matches: [] }) }))),
);

it.effect("derives list visibility only from bearer grants and a usable session cwd", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registered = server.tools.find(
      ({ tool }) => tool.name === GreppyTool.GREPPY_MCP_TOOL_NAME,
    );
    const enabledWhen = Context.get(
      registered!.annotations as Context.Context<McpSchema.EnabledWhen>,
      McpSchema.EnabledWhen,
    );

    const clientClaimsGreppyButBearerDoesNot = yield* Effect.sync(() =>
      enabledWhen(client.initializePayload),
    ).pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation([], "/workspace/project"),
      ),
    );
    const bearerGrantsGreppyWithoutCwd = yield* Effect.sync(() =>
      enabledWhen(client.initializePayload),
    ).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["greppy"])),
    );
    const bearerGrantsGreppyWithCwd = yield* Effect.sync(() =>
      enabledWhen(client.initializePayload),
    ).pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(["greppy"], "/workspace/project"),
      ),
    );

    expect(clientClaimsGreppyButBearerDoesNot).toBe(false);
    expect(bearerGrantsGreppyWithoutCwd).toBe(false);
    expect(bearerGrantsGreppyWithCwd).toBe(true);
  }).pipe(Effect.provide(makeTestLayer({ search: () => Effect.succeed({ matches: [] }) }))),
);

it.effect("independently denies direct calls without the Greppy grant or cwd", () => {
  const search = vi.fn(() => Effect.succeed({ matches: [] }));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;

    const deniedGrant = yield* server
      .callTool({ name: GreppyTool.GREPPY_MCP_TOOL_NAME, arguments: { task: "find retries" } })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation([], "/workspace/project"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(deniedGrant.isError).toBe(true);
    expect(deniedGrant.structuredContent).toEqual({
      error: { _tag: "GreppyMcpSearchError", reason: "capability-not-granted" },
    });

    const deniedCwd = yield* server
      .callTool({ name: GreppyTool.GREPPY_MCP_TOOL_NAME, arguments: { task: "find retries" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["greppy"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(deniedCwd.isError).toBe(true);
    expect(deniedCwd.structuredContent).toEqual({
      error: { _tag: "GreppyMcpSearchError", reason: "session-cwd-unavailable" },
    });
    expect(search).not.toHaveBeenCalled();
  }).pipe(Effect.provide(makeTestLayer({ search })));
});

it.effect("calls Greppy with the authoritative cwd and returns structured matches", () => {
  const search = vi.fn(() =>
    Effect.succeed({
      matches: [{ path: "src/retry.ts", line: 17, excerpt: "Retries failed requests." }],
    }),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: GreppyTool.GREPPY_MCP_TOOL_NAME, arguments: { task: "find retries" } })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(["greppy"], "/workspace/effective"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(search).toHaveBeenCalledWith({
      cwd: "/workspace/effective",
      task: "find retries",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      matches: [{ path: "src/retry.ts", line: 17, excerpt: "Retries failed requests." }],
    });
  }).pipe(Effect.provide(makeTestLayer({ search })));
});
