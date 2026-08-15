import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as GreppyRuntime from "./toolkits/workjet/GreppyRuntime.ts";
import * as WorkerDispatch from "../workjet/WorkerDispatch.ts";
import { GREPPY_MCP_TOOL_NAME } from "./toolkits/workjet/GreppyTool.ts";
import {
  WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME,
  WEB_BROWSER_PREPARE_MCP_TOOL_NAME,
  WEB_DEEP_RESEARCH_MCP_TOOL_NAME,
  WEB_READ_MCP_TOOL_NAME,
  WEB_SEARCH_MCP_TOOL_NAME,
} from "./toolkits/workjet/WebStackTool.ts";
import { WORKJET_DISPATCH_WORKER_TOOL_NAME } from "./toolkits/workjet/WorkerTool.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const WorkerDispatchTestLayer = Layer.succeed(
  WorkerDispatch.WorkerDispatch,
  WorkerDispatch.WorkerDispatch.of({ dispatch: () => Effect.die("unused") }),
);
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("filters tools/list by the authoritative bearer scope and preserves Preview tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scopes = new Map<string, McpInvocationContext.McpInvocationScope>([
        [
          "hidden-token",
          {
            ...invocation,
            activeWorkjetMcpCapabilityIds: new Set(),
            cwd: "/workspace/project",
          },
        ],
        [
          "standard-role-token",
          {
            ...invocation,
            workjetRole: "standard",
          },
        ],
        [
          "worker-role-token",
          {
            ...invocation,
            workjetRole: "worker",
          },
        ],
        [
          "orchestrator-role-token",
          {
            ...invocation,
            workjetRole: "orchestrator",
          },
        ],
        [
          "greppy-missing-cwd-token",
          {
            ...invocation,
            activeWorkjetMcpCapabilityIds: new Set(["greppy"]),
          },
        ],
        [
          "greppy-only-token",
          {
            ...invocation,
            activeWorkjetMcpCapabilityIds: new Set(["greppy"]),
            cwd: "/workspace/project",
          },
        ],
        [
          "web-search-only-token",
          {
            ...invocation,
            activeWorkjetMcpCapabilityIds: new Set(["web-search"]),
          },
        ],
        [
          "browser-only-token",
          {
            ...invocation,
            activeWorkjetMcpCapabilityIds: new Set(["web-stack-browser"]),
          },
        ],
        [
          "all-token",
          {
            ...invocation,
            activeWorkjetMcpCapabilityIds: new Set(["greppy", "web-search", "web-stack-browser"]),
            cwd: "/workspace/project",
          },
        ],
      ]);
      const registry = McpSessionRegistry.McpSessionRegistry.of({
        issue: () => Effect.die("unused"),
        resolve: (token) => Effect.succeed(scopes.get(token)),
        touch: () => Effect.void,
        revokeProviderSession: () => Effect.void,
        revokeThread: () => Effect.void,
        revokeAll: Effect.void,
      });
      const routes = McpHttpServer.layer.pipe(
        Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
        Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
        Layer.provide(GreppyRuntime.layer),
        Layer.provide(WorkerDispatchTestLayer),
        Layer.provide(
          ServerConfig.layerTest(
            process.cwd(),
            "/Volumes/tmp/workjet/tmp/mcp-http-server-test",
          ).pipe(Layer.provide(NodeServices.layer)),
        ),
        Layer.provide(NodeServices.layer),
      );
      yield* HttpRouter.serve(routes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const listTools = Effect.fn(function* (token: string) {
        const initializeResponse = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"experimental":{"greppy":true}},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
            "application/json",
          ),
        });
        const sessionId = initializeResponse.headers["mcp-session-id"];
        expect(initializeResponse.status).toBe(200);
        expect(sessionId).not.toBeNull();
        expect(sessionId).toBeDefined();

        const initializedResponse = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            "mcp-session-id": sessionId!,
            "mcp-protocol-version": "2025-06-18",
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","method":"notifications/initialized"}`,
            "application/json",
          ),
        });
        expect(initializedResponse.status).toBe(202);

        const listResponse = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            "mcp-session-id": sessionId!,
            "mcp-protocol-version": "2025-06-18",
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
            "application/json",
          ),
        });
        expect(listResponse.status).toBe(200);
        const body = (yield* listResponse.json) as {
          readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> };
        };
        return body.result.tools.map(({ name }) => name);
      });

      const hidden = yield* listTools("hidden-token");
      const standardRole = yield* listTools("standard-role-token");
      const workerRole = yield* listTools("worker-role-token");
      const orchestratorRole = yield* listTools("orchestrator-role-token");
      const greppyMissingCwd = yield* listTools("greppy-missing-cwd-token");
      const greppyOnly = yield* listTools("greppy-only-token");
      const webSearchOnly = yield* listTools("web-search-only-token");
      const browserOnly = yield* listTools("browser-only-token");
      const all = yield* listTools("all-token");

      expect(standardRole).not.toContain(WORKJET_DISPATCH_WORKER_TOOL_NAME);
      expect(workerRole).not.toContain(WORKJET_DISPATCH_WORKER_TOOL_NAME);
      expect(hidden).not.toContain(WORKJET_DISPATCH_WORKER_TOOL_NAME);
      expect(orchestratorRole).toContain(WORKJET_DISPATCH_WORKER_TOOL_NAME);

      for (const browserTool of [
        WEB_BROWSER_PREPARE_MCP_TOOL_NAME,
        WEB_BROWSER_AUTOMATE_MCP_TOOL_NAME,
      ]) {
        expect(hidden).not.toContain(browserTool);
        expect(greppyMissingCwd).not.toContain(browserTool);
        expect(greppyOnly).not.toContain(browserTool);
        expect(webSearchOnly).not.toContain(browserTool);
        expect(browserOnly).toContain(browserTool);
        expect(all).toContain(browserTool);
      }
      expect(hidden).not.toContain(GREPPY_MCP_TOOL_NAME);
      expect(greppyMissingCwd).not.toContain(GREPPY_MCP_TOOL_NAME);
      expect(greppyOnly).toContain(GREPPY_MCP_TOOL_NAME);
      expect(webSearchOnly).not.toContain(GREPPY_MCP_TOOL_NAME);
      expect(browserOnly).not.toContain(GREPPY_MCP_TOOL_NAME);
      expect(all).toContain(GREPPY_MCP_TOOL_NAME);
      for (const researchTool of [
        WEB_SEARCH_MCP_TOOL_NAME,
        WEB_READ_MCP_TOOL_NAME,
        WEB_DEEP_RESEARCH_MCP_TOOL_NAME,
      ]) {
        expect(hidden).not.toContain(researchTool);
        expect(greppyMissingCwd).not.toContain(researchTool);
        expect(greppyOnly).not.toContain(researchTool);
        expect(webSearchOnly).toContain(researchTool);
        expect(browserOnly).not.toContain(researchTool);
        expect(all).toContain(researchTool);
      }
      expect(hidden).toContain("preview_status");
      expect(greppyOnly).toContain("preview_status");
      expect(webSearchOnly).toContain("preview_status");
      expect(browserOnly).toContain("preview_status");
      expect(all).toContain("preview_status");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
