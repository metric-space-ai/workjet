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
import { CtoxNativeRequests } from "../../../workjet/ctox/CtoxNativeRequests.ts";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import migration60 from "../../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
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

function fixture(retrySupport = false, loseDelegationResponse = false) {
  const calls: Array<{ url: string; body: typeof Request.Type }> = [];
  const resolutions: Array<{ id: string; instanceId: string | undefined }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON");
      const body = decode(new TextDecoder().decode(request.body.body));
      calls.push({ url: request.url, body });
      if (loseDelegationResponse && body.method === "tools/call") {
        return HttpClientResponse.fromWeb(request, new Response("lost response", { status: 502 }));
      }
      const result =
        body.method === "initialize"
          ? { serverInfo: { name: "ctox-business-os-mcp" } }
          : body.method === "tools/list"
            ? {
                tools: [
                  { name: "business_os.write_app_file" },
                  { name: "business_os.get_command_status" },
                  {
                    name: "business_os.modify_app",
                    inputSchema: {
                      type: "object",
                      properties: retrySupport ? { idempotency_key: { type: "string" } } : {},
                    },
                  },
                  {
                    name: "business_os.execute_action",
                    inputSchema: {
                      type: "object",
                      properties: retrySupport ? { idempotency_key: { type: "string" } } : {},
                    },
                  },
                ],
              }
            : {
                structuredContent:
                  body.params?.name === "business_os.modify_app" ||
                  body.params?.name === "business_os.execute_action"
                    ? {
                        ok: true,
                        module_id: "app-a",
                        command_type:
                          body.params?.name === "business_os.execute_action"
                            ? "ctox.delegate_task"
                            : "ctox.business_os.app.modify",
                        command_id: "cmd-native-a",
                        task_id: "task-native-a",
                        status: "accepted",
                      }
                    : body.params?.name === "business_os.get_command_status"
                      ? {
                          ok: true,
                          record: {
                            id: "cmd-native-a",
                            collection: "business_commands",
                            status: "failed",
                            data: {
                              command_id: "cmd-native-a",
                              task_id: "task-native-a",
                              module: "app-a",
                              status: "failed",
                              status_note: "Native validation failed",
                            },
                          },
                        }
                      : { ok: true, module_id: "app-a" },
              };
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
    Layer.provideMerge(
      CtoxNativeRequests.layer.pipe(
        Layer.provide(
          Layer.effectDiscard(migration60).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
        ),
      ),
    ),
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
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)).not.toContain(
      "server-only-test-token",
    );
  }).pipe(Effect.provide(test.layer));
});

it.effect("dispatches a retry key only when the native operation advertises support", () =>
  Effect.gen(function* () {
    for (const operation of ["modify_app", "delegate_task"] as const) {
      for (const supported of [false, true]) {
        const test = fixture(supported);
        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const result = yield* server
            .callTool({
              name: CTOX_BUSINESS_OS_TOOL_NAME,
              arguments: {
                request: {
                  operation,
                  module_id: "app-a",
                  ...(operation === "modify_app"
                    ? { instruction: "Add an inventory review action" }
                    : { title: "Inventory review", objective: "Review the inventory" }),
                  idempotency_key: "workjet-turn-1",
                },
              },
            })
            .pipe(
              Effect.provideService(Invocation.McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
          const writes = test.calls.filter(({ body }) => body.method === "tools/call");
          expect(result.isError).toBe(!supported);
          if (supported) {
            expect(writes).toHaveLength(1);
            expect(writes[0]?.body.params).toEqual({
              name:
                operation === "modify_app"
                  ? "business_os.modify_app"
                  : "business_os.execute_action",
              arguments: {
                module_id: "app-a",
                ...(operation === "modify_app"
                  ? { instruction: "Add an inventory review action" }
                  : {
                      action_id: "ctox.delegate_task",
                      title: "Inventory review",
                      objective: "Review the inventory",
                    }),
                idempotency_key: expect.stringMatching(/^workjet_[a-f0-9-]{36}$/),
              },
            });
          } else {
            expect(writes).toEqual([]);
            expect(result.structuredContent).toMatchObject({
              error: { reason: "remote-tools-missing" },
            });
          }
        }).pipe(Effect.provide(test.layer));
      }
    }
  }),
);

it.effect(
  "recovers a lost-response delegation from durable intent without another remote call",
  () => {
    const test = fixture(true, true);
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const request = {
        operation: "modify_app",
        module_id: "app-a",
        instruction: "Add an inventory review action",
        idempotency_key: "lost-response-request",
      };
      const dispatch = yield* server.callTool({
        name: CTOX_BUSINESS_OS_TOOL_NAME,
        arguments: { request },
      });
      expect(dispatch.isError).toBe(true);
      const callsBeforeRead = test.calls.length;
      const recovered = yield* server.callTool({
        name: CTOX_BUSINESS_OS_TOOL_NAME,
        arguments: {
          request: { operation: "get_delegation", idempotency_key: request.idempotency_key },
        },
      });
      expect(recovered.isError).toBe(false);
      expect(recovered.structuredContent).toMatchObject({
        instanceId: "instance-a",
        result: { request, commandId: null, taskId: null, receivedAt: null },
      });
      const status = yield* server.callTool({
        name: CTOX_BUSINESS_OS_TOOL_NAME,
        arguments: {
          request: { operation: "get_delegation_status", idempotency_key: request.idempotency_key },
        },
      });
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        result: { state: "unresolved", status: null, reference: { commandId: null, taskId: null } },
      });
      expect(test.calls).toHaveLength(callsBeforeRead);
    }).pipe(
      Effect.provideService(Invocation.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(test.layer),
    );
  },
);

it.effect("observes the bound native command without resubmitting work", () => {
  const test = fixture(true);
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const created = yield* server.callTool({
      name: CTOX_BUSINESS_OS_TOOL_NAME,
      arguments: {
        request: {
          operation: "delegate_task",
          module_id: "app-a",
          title: "Review",
          objective: "Review inventory",
          idempotency_key: "observe-request",
        },
      },
    });
    expect(created.isError).toBe(false);
    const observed = yield* server.callTool({
      name: CTOX_BUSINESS_OS_TOOL_NAME,
      arguments: {
        request: { operation: "get_delegation_status", idempotency_key: "observe-request" },
      },
    });
    expect(observed.isError).toBe(false);
    expect(observed.structuredContent).toMatchObject({
      instanceId: "instance-a",
      result: {
        state: "failed",
        status: "failed",
        note: "Native validation failed",
        reference: { commandId: "cmd-native-a", taskId: "task-native-a" },
      },
    });
    expect(
      test.calls
        .filter(({ body }) => body.method === "tools/call")
        .map(({ body }) => body.params?.name),
    ).toEqual(["business_os.execute_action", "business_os.get_command_status"]);
    expect(test.calls.at(-1)?.body.params?.arguments).toEqual({ command_id: "cmd-native-a" });
  }).pipe(
    Effect.provideService(Invocation.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(test.layer),
  );
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

/**
 * THE DENIAL PATH.
 *
 * WorkjetToolScopeGate proves this handler CALLS a scope enforcer. It cannot
 * prove the refusal reaches the caller, and it cannot prove the refusal happens
 * before the tool touches the bound instance. Every case above runs with a fully
 * granted scope, so until now the denial branch had no coverage at all — it could
 * have resolved the thread's target first, or returned a success shape, and the
 * whole suite would still be green.
 *
 * What must hold for an ungranted caller: no target resolution, no request to the
 * instance, and no success.
 */
const { workjetRole: _role, ...scopeWithoutRole } = scope;
const { ctoxBusinessOsBinding: _binding, ...scopeWithoutBinding } = scope;

const ungrantedScopes: ReadonlyArray<{
  readonly name: string;
  readonly scope: Invocation.McpInvocationScope;
}> = [
  {
    name: "the ctox-business-os capability is not active on the thread",
    scope: { ...scope, activeWorkjetMcpCapabilityIds: new Set() },
  },
  { name: "the caller holds no Workjet role", scope: scopeWithoutRole },
  { name: "the thread has no bound instance", scope: scopeWithoutBinding },
];

it.effect("refuses an ungranted invocation scope without reaching the instance", () =>
  Effect.gen(function* () {
    for (const ungranted of ungrantedScopes) {
      const test = fixture();
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const outcome = yield* server
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
            Effect.provideService(Invocation.McpInvocationContext, ungranted.scope),
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.result,
          );
        // Failing the call (the tool is not enabled for this scope) and returning
        // the structured denial are both refusals. A plain success is not.
        if (outcome._tag === "Success") {
          expect(outcome.success.isError, ungranted.name).toBe(true);
          expect(outcome.success.structuredContent, ungranted.name).toEqual({
            error: { _tag: "CtoxBusinessOsError", reason: "capability-not-granted" },
          });
        }
        expect(test.resolutions, ungranted.name).toEqual([]);
        expect(test.calls, ungranted.name).toEqual([]);
      }).pipe(Effect.provide(test.layer));
    }
  }),
);
