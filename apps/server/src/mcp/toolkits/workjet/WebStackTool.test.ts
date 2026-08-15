import {
  builtInCapabilityManifests,
  WEB_DEEP_RESEARCH_INPUT_SCHEMA,
  WEB_READ_INPUT_SCHEMA,
} from "@metric-space-ai/workjet-capabilities";
import { expect, it, vi } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WebStackBrowser from "./WebStackBrowser.ts";
import * as WebStackResearch from "./WebStackResearch.ts";
import * as WebStackSearch from "./WebStackSearch.ts";
import * as WebStackTool from "./WebStackTool.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: { experimental: { webSearch: true } },
    clientInfo: { name: "web-search-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation = (
  grants: ReadonlyArray<"greppy" | "web-search" | "web-stack-browser">,
  cwd?: string,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-web-search-test"),
  threadId: ThreadId.make("thread-web-search-test"),
  providerSessionId: "provider-session-web-search-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"]),
  activeWorkjetMcpCapabilityIds: new Set(grants),
  ...(cwd ? { cwd } : {}),
  issuedAt: 1,
});

function makeTestLayer(
  search: WebStackSearch.WebStackSearchShape,
  browser: WebStackBrowser.WebStackBrowserShape = {
    prepare: () =>
      Effect.succeed({
        ready: false,
        dependencyInstalled: false,
        browserInstalled: false,
        installAttempted: false,
        dependencyInstallRan: false,
        browserInstallRan: false,
        reason: "dependency-missing",
      }),
    automate: () => Effect.succeed({ observations: [] }),
  },
  research: WebStackResearch.WebStackResearchShape = {
    read: () => Effect.succeed({ operation: "read" }),
    deepResearch: () => Effect.succeed({ operation: "deepResearch" }),
  },
) {
  return WebStackTool.WebStackToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.succeed(WebStackSearch.WebStackSearch, WebStackSearch.WebStackSearch.of(search)),
    ),
    Layer.provideMerge(
      Layer.succeed(
        WebStackResearch.WebStackResearch,
        WebStackResearch.WebStackResearch.of(research),
      ),
    ),
    Layer.provide(
      Layer.succeed(WebStackBrowser.WebStackBrowser, WebStackBrowser.WebStackBrowser.of(browser)),
    ),
  );
}

it.effect("registers Web Search with the canonical built-in MCP schemas and annotations", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registered = server.tools.find(
      ({ tool }) => tool.name === WebStackTool.WEB_SEARCH_MCP_TOOL_NAME,
    );
    const manifest = builtInCapabilityManifests.find(
      ({ id, version }) => id === "web-search" && version === "1.0.0",
    );

    expect(registered).toBeDefined();
    expect(registered?.tool.inputSchema).toEqual(manifest?.inputSchema);
    expect(registered?.tool.outputSchema).toEqual(manifest?.outputSchema);
    expect(registered?.tool.annotations).toMatchObject({
      title: "Web Search",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(server.tools.map(({ tool }) => tool.name)).not.toContain("web_stack_browser");
  }).pipe(Effect.provide(makeTestLayer({ search: () => Effect.succeed({ results: [] }) }))),
);

it.effect("derives list visibility only from the authoritative Web Search bearer grant", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registered = server.tools.find(
      ({ tool }) => tool.name === WebStackTool.WEB_SEARCH_MCP_TOOL_NAME,
    );
    const enabledWhen = Context.get(
      registered!.annotations as Context.Context<McpSchema.EnabledWhen>,
      McpSchema.EnabledWhen,
    );

    const clientClaimWithoutGrant = yield* Effect.sync(() =>
      enabledWhen(client.initializePayload),
    ).pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation([], "/workspace/project"),
      ),
    );
    const grantWithoutCwd = yield* Effect.sync(() => enabledWhen(client.initializePayload)).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["web-search"])),
    );

    expect(clientClaimWithoutGrant).toBe(false);
    expect(grantWithoutCwd).toBe(true);
  }).pipe(Effect.provide(makeTestLayer({ search: () => Effect.succeed({ results: [] }) }))),
);

it.effect("independently denies direct calls without the Web Search grant", () => {
  const search = vi.fn(() => Effect.succeed({ results: [] }));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const denied = yield* server
      .callTool({ name: WebStackTool.WEB_SEARCH_MCP_TOOL_NAME, arguments: { query: "rust" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation([])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toEqual({
      error: { _tag: "WebStackMcpSearchError", reason: "capability-not-granted" },
    });
    expect(denied.content).toEqual([{ type: "text", text: "Web Search failed." }]);
    expect(search).not.toHaveBeenCalled();
  }).pipe(Effect.provide(makeTestLayer({ search })));
});

it.effect("validates direct call input before invoking Web Search", () => {
  const search = vi.fn(() => Effect.succeed({ results: [] }));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const invalid = yield* server
      .callTool({
        name: WebStackTool.WEB_SEARCH_MCP_TOOL_NAME,
        arguments: { query: "x".repeat(2_001), unexpected: true },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(["web-search"]),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.flip,
      );

    expect(invalid._tag).toBe("InvalidParams");
    expect(search).not.toHaveBeenCalled();
  }).pipe(Effect.provide(makeTestLayer({ search })));
});

it.effect("calls Web Search without cwd and returns the exact manifest result", () => {
  const result = {
    results: [
      {
        title: "Effect documentation",
        url: "https://effect.website/",
        snippet: "Effect is a TypeScript library.",
      },
    ],
  };
  const search = vi.fn(() => Effect.succeed(result));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const response = yield* server
      .callTool({
        name: WebStackTool.WEB_SEARCH_MCP_TOOL_NAME,
        arguments: { query: "Effect TypeScript" },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(["web-search"]),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(search).toHaveBeenCalledWith({ query: "Effect TypeScript" });
    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual(result);
    expect(response.content).toEqual([{ type: "text", text: JSON.stringify(result) }]);
  }).pipe(Effect.provide(makeTestLayer({ search })));
});

it.effect("returns only a stable redacted reason for Web Search failures", () => {
  const secret = "SENSITIVE_NATIVE_STDERR";
  const error = new WebStackSearch.WebStackSearchError({ reason: "process-exit" });
  Object.defineProperty(error, "internal", { value: secret });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const response = yield* server
      .callTool({ name: WebStackTool.WEB_SEARCH_MCP_TOOL_NAME, arguments: { query: secret } })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(["web-search"]),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({
      error: { _tag: "WebStackMcpSearchError", reason: "process-exit" },
    });
    expect(response.content).toEqual([{ type: "text", text: "Web Search failed." }]);
    expect(JSON.stringify(response)).not.toContain(secret);
  }).pipe(Effect.provide(makeTestLayer({ search: () => Effect.fail(error) })));
});

it.effect("registers both browser tools with the browser manifest automation schemas", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const prepare = server.tools.find(
      ({ tool }) => tool.name === WebStackTool.WEB_BROWSER_PREPARE_MCP_TOOL_NAME,
    );
    const automate = server.tools.find(
      ({ tool }) => tool.name === WebStackTool.WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME,
    );
    const manifest = builtInCapabilityManifests.find(
      ({ id, version }) => id === "web-stack-browser" && version === "1.0.0",
    );

    expect(prepare).toBeDefined();
    expect(prepare?.tool.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(prepare?.tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(automate?.tool.inputSchema).toEqual(manifest?.inputSchema);
    expect(automate?.tool.outputSchema).toEqual(manifest?.outputSchema);
    expect(automate?.tool.annotations).toMatchObject({
      title: "Web Stack Browser",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  }).pipe(Effect.provide(makeTestLayer({ search: () => Effect.succeed({ results: [] }) }))),
);

it.effect("shows both browser tools only for the browser bearer grant without requiring cwd", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const name of [
      WebStackTool.WEB_BROWSER_PREPARE_MCP_TOOL_NAME,
      WebStackTool.WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME,
    ]) {
      const registered = server.tools.find(({ tool }) => tool.name === name);
      const enabledWhen = Context.get(
        registered!.annotations as Context.Context<McpSchema.EnabledWhen>,
        McpSchema.EnabledWhen,
      );
      expect(
        yield* Effect.sync(() => enabledWhen(client.initializePayload)).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation([])),
        ),
      ).toBe(false);
      expect(
        yield* Effect.sync(() => enabledWhen(client.initializePayload)).pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(["web-stack-browser"]),
          ),
        ),
      ).toBe(true);
    }
  }).pipe(Effect.provide(makeTestLayer({ search: () => Effect.succeed({ results: [] }) }))),
);

it.effect("independently denies direct browser calls without the browser grant", () => {
  const prepare = vi.fn(() => Effect.die("must not prepare"));
  const automate = vi.fn(() => Effect.die("must not automate"));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const call of [
      { name: WebStackTool.WEB_BROWSER_PREPARE_MCP_TOOL_NAME, arguments: {} },
      {
        name: WebStackTool.WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME,
        arguments: { actions: [{ action: "observe" }] },
      },
    ]) {
      const denied = yield* server
        .callTool(call)
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation([])),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        error: { _tag: "WebStackMcpBrowserError", reason: "capability-not-granted" },
      });
      expect(denied.content).toEqual([{ type: "text", text: "Web Browser failed." }]);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(automate).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      makeTestLayer({ search: () => Effect.succeed({ results: [] }) }, { prepare, automate }),
    ),
  );
});

it.effect(
  "rejects raw source, unknown actions, target ambiguity, and prepare path overrides",
  () => {
    const prepare = vi.fn(() => Effect.die("must not prepare"));
    const automate = vi.fn(() => Effect.die("must not automate"));
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      for (const call of [
        {
          name: WebStackTool.WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME,
          arguments: { source: "return process.env" },
        },
        {
          name: WebStackTool.WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME,
          arguments: { actions: [{ action: "evaluate", source: "1+1" }] },
        },
        {
          name: WebStackTool.WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME,
          arguments: {
            actions: [{ action: "click", target: { selector: "#x", text: "x" } }],
          },
        },
        {
          name: WebStackTool.WEB_BROWSER_PREPARE_MCP_TOOL_NAME,
          arguments: { root: "/tmp", installBrowser: false },
        },
      ]) {
        const error = yield* server
          .callTool(call)
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(["web-stack-browser"]),
            ),
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.flip,
          );
        expect(error._tag).toBe("InvalidParams");
      }
      expect(prepare).not.toHaveBeenCalled();
      expect(automate).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        makeTestLayer({ search: () => Effect.succeed({ results: [] }) }, { prepare, automate }),
      ),
    );
  },
);

it.effect(
  "calls browser preparation and automation without cwd and returns normalized results",
  () => {
    const prepared = {
      ready: true,
      dependencyInstalled: true,
      browserInstalled: true,
      installAttempted: true,
      dependencyInstallRan: true,
      browserInstallRan: true,
      reason: "ready" as const,
    };
    const automated = {
      observations: [{ description: "Observed Example", url: "https://example.test/" }],
    };
    const prepare = vi.fn(() => Effect.succeed(prepared));
    const automate = vi.fn(() => Effect.succeed(automated));
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const prepareResponse = yield* server
        .callTool({
          name: WebStackTool.WEB_BROWSER_PREPARE_MCP_TOOL_NAME,
          arguments: { installReference: true, installBrowser: true },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(["web-stack-browser"]),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      const automateResponse = yield* server
        .callTool({
          name: WebStackTool.WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME,
          arguments: {
            actions: [
              { action: "navigate", url: "https://example.test/" },
              { action: "click", target: { role: "button", name: "Continue" } },
            ],
            timeoutMs: 1_000,
          },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(["web-stack-browser"]),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(prepare).toHaveBeenCalledWith({ installReference: true, installBrowser: true });
      expect(automate).toHaveBeenCalledWith({
        actions: [
          { action: "navigate", url: "https://example.test/" },
          { action: "click", target: { role: "button", name: "Continue" } },
        ],
        timeoutMs: 1_000,
      });
      expect(prepareResponse.structuredContent).toEqual(prepared);
      expect(automateResponse.structuredContent).toEqual(automated);
      expect(automateResponse.content).toEqual([{ type: "text", text: JSON.stringify(automated) }]);
    }).pipe(
      Effect.provide(
        makeTestLayer({ search: () => Effect.succeed({ results: [] }) }, { prepare, automate }),
      ),
    );
  },
);

it.effect("registers read and deep research with canonical schemas and exact annotations", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const read = server.tools.find(({ tool }) => tool.name === WebStackTool.WEB_READ_MCP_TOOL_NAME);
    const research = server.tools.find(
      ({ tool }) => tool.name === WebStackTool.WEB_DEEP_RESEARCH_MCP_TOOL_NAME,
    );

    expect(read?.tool.inputSchema).toEqual(WEB_READ_INPUT_SCHEMA);
    expect(read?.tool.annotations).toMatchObject({
      title: "Read Web Page",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(research?.tool.inputSchema).toEqual(WEB_DEEP_RESEARCH_INPUT_SCHEMA);
    expect(research?.tool.annotations).toMatchObject({
      title: "Deep Web Research",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  }).pipe(Effect.provide(makeTestLayer({ search: () => Effect.succeed({ results: [] }) }))),
);

it.effect("gates both research tools only on the one Web Search bearer grant", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const name of [
      WebStackTool.WEB_READ_MCP_TOOL_NAME,
      WebStackTool.WEB_DEEP_RESEARCH_MCP_TOOL_NAME,
    ]) {
      const registered = server.tools.find(({ tool }) => tool.name === name);
      const enabledWhen = Context.get(
        registered!.annotations as Context.Context<McpSchema.EnabledWhen>,
        McpSchema.EnabledWhen,
      );
      expect(
        yield* Effect.sync(() => enabledWhen(client.initializePayload)).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation([])),
        ),
      ).toBe(false);
      expect(
        yield* Effect.sync(() => enabledWhen(client.initializePayload)).pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(["web-search"]),
          ),
        ),
      ).toBe(true);
      expect(
        yield* Effect.sync(() => enabledWhen(client.initializePayload)).pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(["web-stack-browser"]),
          ),
        ),
      ).toBe(false);
    }
  }).pipe(Effect.provide(makeTestLayer({ search: () => Effect.succeed({ results: [] }) }))),
);

it.effect("independently denies direct read and research calls before service invocation", () => {
  const read = vi.fn(() => Effect.die("must not read"));
  const deepResearch = vi.fn(() => Effect.die("must not research"));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const call of [
      {
        name: WebStackTool.WEB_READ_MCP_TOOL_NAME,
        arguments: { url: "https://example.test/secret" },
        operation: "read",
      },
      {
        name: WebStackTool.WEB_DEEP_RESEARCH_MCP_TOOL_NAME,
        arguments: { query: "secret query" },
        operation: "deep-research",
      },
    ]) {
      const denied = yield* server
        .callTool({ name: call.name, arguments: call.arguments })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation([])),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toEqual({
        error: {
          _tag: "WebStackMcpResearchError",
          operation: call.operation,
          reason: "capability-not-granted",
        },
      });
      expect(denied.content).toEqual([{ type: "text", text: "Web research failed." }]);
    }
    expect(read).not.toHaveBeenCalled();
    expect(deepResearch).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      makeTestLayer({ search: () => Effect.succeed({ results: [] }) }, undefined, {
        read,
        deepResearch,
      }),
    ),
  );
});

it.effect("rejects invalid path-bearing research payloads with InvalidParams", () => {
  const read = vi.fn(() => Effect.die("must not read"));
  const deepResearch = vi.fn(() => Effect.die("must not research"));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const call of [
      {
        name: WebStackTool.WEB_READ_MCP_TOOL_NAME,
        arguments: { url: "https://example.test/", workspace: "/tmp" },
      },
      {
        name: WebStackTool.WEB_DEEP_RESEARCH_MCP_TOOL_NAME,
        arguments: { query: "research", path: "/tmp", includePapers: true },
      },
      {
        name: WebStackTool.WEB_DEEP_RESEARCH_MCP_TOOL_NAME,
        arguments: { query: " ", maxSources: 2 },
      },
    ]) {
      const error = yield* server
        .callTool(call)
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(["web-search"]),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(error._tag).toBe("InvalidParams");
    }
    expect(read).not.toHaveBeenCalled();
    expect(deepResearch).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      makeTestLayer({ search: () => Effect.succeed({ results: [] }) }, undefined, {
        read,
        deepResearch,
      }),
    ),
  );
});

it.effect("applies research defaults and returns successful structured evidence", () => {
  const readResult = {
    operation: "read",
    canonicalUrl: "https://example.test/canonical",
    pageTextExcerpt: "Evidence",
  };
  const researchResult = {
    operation: "deepResearch",
    evidenceStatus: "verified_sources_available",
    verifiedSources: [{ canonicalUrl: "https://example.test/source" }],
    workspacePersisted: true,
  };
  const read = vi.fn(() => Effect.succeed(readResult));
  const deepResearch = vi.fn(() => Effect.succeed(researchResult));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const readResponse = yield* server
      .callTool({
        name: WebStackTool.WEB_READ_MCP_TOOL_NAME,
        arguments: { url: "https://example.test/", find: ["evidence"], country: "CH" },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(["web-search"]),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const researchResponse = yield* server
      .callTool({
        name: WebStackTool.WEB_DEEP_RESEARCH_MCP_TOOL_NAME,
        arguments: { query: "bounded research" },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(["web-search"]),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(read).toHaveBeenCalledWith({
      url: "https://example.test/",
      find: ["evidence"],
      country: "CH",
    });
    expect(deepResearch).toHaveBeenCalledWith({
      query: "bounded research",
      depth: "standard",
      maxSources: 16,
      excludeUrls: [],
      includePapers: true,
      includeAnnasArchive: false,
    });
    expect(readResponse.structuredContent).toEqual(readResult);
    expect(readResponse.content).toEqual([{ type: "text", text: JSON.stringify(readResult) }]);
    expect(researchResponse.structuredContent).toEqual(researchResult);
  }).pipe(
    Effect.provide(
      makeTestLayer({ search: () => Effect.succeed({ results: [] }) }, undefined, {
        read,
        deepResearch,
      }),
    ),
  );
});

it.effect("returns only a stable reason for native research failures", () => {
  const secret = "SENSITIVE_URL_QUERY_STDERR";
  const error = new WebStackResearch.WebStackResearchError({ reason: "process-exit" });
  Object.defineProperty(error, "internal", { value: secret });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const response = yield* server
      .callTool({
        name: WebStackTool.WEB_READ_MCP_TOOL_NAME,
        arguments: { url: `https://example.test/${secret}` },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(["web-search"]),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(response.structuredContent).toEqual({
      error: {
        _tag: "WebStackMcpResearchError",
        operation: "read",
        reason: "process-exit",
      },
    });
    expect(response.content).toEqual([{ type: "text", text: "Web research failed." }]);
    expect(JSON.stringify(response)).not.toContain(secret);
  }).pipe(
    Effect.provide(
      makeTestLayer({ search: () => Effect.succeed({ results: [] }) }, undefined, {
        read: () => Effect.fail(error),
        deepResearch: () => Effect.fail(error),
      }),
    ),
  );
});
