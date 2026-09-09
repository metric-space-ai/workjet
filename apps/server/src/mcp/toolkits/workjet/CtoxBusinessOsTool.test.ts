import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WorkjetConnectionId,
  WorkjetDecisionHubConnectionError,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as Invocation from "../../McpInvocationContext.ts";
import { DecisionHubConnectionRegistry } from "../../../workjet/decisionHub/DecisionHubConnectionRegistry.ts";
import {
  CtoxBusinessOsToolkitRegistrationLive,
  CTOX_BUSINESS_OS_TOOL_NAME,
} from "./CtoxBusinessOsTool.ts";

const connectionId = WorkjetConnectionId.make("bound-connection");
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "session-a",
  capabilities: new Set(),
  activeWorkjetMcpCapabilityIds: new Set(["ctox-business-os"]),
  workjetRole: "standard",
  issuedAt: 1,
  ctoxBusinessOsBinding: { connectionId, instanceId: "instance-a" },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const Request = Schema.Struct({
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Unknown),
    }),
  ),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Request));

function fixture() {
  const calls: Array<{ url: string; body: typeof Request.Type }> = [];
  const resolutions: Array<{ id: string; instanceId: string | undefined }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON");
      const body = decode(new TextDecoder().decode(request.body.body));
      calls.push({ url: request.url, body });
      const result =
        body.method === "initialize"
          ? { serverInfo: { name: "ctox-business-os-mcp" } }
          : body.method === "tools/list"
            ? {
                tools: [
                  { name: "business_os.write_app_file" },
                  { name: "business_os.get_command_status" },
                ],
              }
            : { structuredContent: { ok: true, module_id: "app-a" } };
      return HttpClientResponse.fromWeb(request, Response.json({ jsonrpc: "2.0", result }));
    }),
  );
  const registry = DecisionHubConnectionRegistry.of({
    list: Effect.succeed([]),
    provision: () => Effect.die("unused"),
    probe: () => Effect.die("unused"),
    disconnect: () => Effect.die("unused"),
    resolveReadyTarget: (id, instanceId) =>
      Effect.gen(function* () {
        resolutions.push({ id, instanceId });
        if (id !== connectionId || instanceId !== "instance-a")
          return yield* new WorkjetDecisionHubConnectionError({
            reason: "connection-instance-mismatch",
          });
        return { endpoint: "https://mcp.ctox.dev/mcp/instance-a", token: "server-only-test-token" };
      }),
  });
  const layer = CtoxBusinessOsToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(Layer.succeed(DecisionHubConnectionRegistry, registry)),
  );
  return { calls, resolutions, layer };
}

it.effect("writes through the registered MCP tool using only the session's pinned target", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: CTOX_BUSINESS_OS_TOOL_NAME,
        arguments: {
          request: {
            operation: "write_app_file",
            module_id: "app-a",
            path: "index.js",
            content: "export {};",
          },
        },
      })
      .pipe(
        Effect.provideService(Invocation.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      instanceId: "instance-a",
      result: { ok: true, module_id: "app-a" },
    });
    expect(test.resolutions).toEqual([{ id: connectionId, instanceId: "instance-a" }]);
    expect(test.calls.map(({ url }) => url)).toEqual(
      Array(3).fill("https://mcp.ctox.dev/mcp/instance-a"),
    );
    expect(test.calls[2]?.body.params).toEqual({
      name: "business_os.write_app_file",
      arguments: { module_id: "app-a", path: "index.js", content: "export {};" },
    });
    expect(JSON.stringify(result)).not.toContain("server-only-test-token");
  }).pipe(Effect.provide(test.layer));
});

it.effect("does not contact CTOX after a revoked grant or an instance mismatch", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const invocation of [
      { ...scope, activeWorkjetMcpCapabilityIds: new Set<"ctox-business-os">() },
      { ...scope, ctoxBusinessOsBinding: { connectionId, instanceId: "instance-b" } },
    ]) {
      const result = yield* server
        .callTool({
          name: CTOX_BUSINESS_OS_TOOL_NAME,
          arguments: {
            request: { operation: "get_command_status", command_id: "command-a" },
          },
        })
        .pipe(
          Effect.provideService(Invocation.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
    }
    expect(test.calls).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});
