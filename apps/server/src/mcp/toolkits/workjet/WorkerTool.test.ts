// @effect-diagnostics preferSchemaOverJson:off -- redaction assertions inspect complete bounded MCP results.
import { expect, it, vi } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkerDispatch from "../../../workjet/WorkerDispatch.ts";
import {
  WORKJET_DISPATCH_WORKER_TOOL_NAME,
  WorkerDispatchMcpTool,
  WorkerToolkitRegistrationLive,
  decodeWorkerDispatchInput,
  isWorkerDispatchToolVisible,
} from "./WorkerTool.ts";

const environmentId = EnvironmentId.make("environment-worker-tool");
const threadId = ThreadId.make("thread-orchestrator");
const baseInvocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-worker-tool",
  providerInstanceId: ProviderInstanceId.make("codex-main"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "worker-tool-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const makeTestLayer = (workerDispatch: WorkerDispatch.WorkerDispatchShape) =>
  WorkerToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(WorkerDispatch.WorkerDispatch, workerDispatch)),
  );

it("is visible only to an exact orchestrator bearer scope", () => {
  expect(isWorkerDispatchToolVisible({ ...baseInvocation, workjetRole: "orchestrator" })).toBe(
    true,
  );
  expect(isWorkerDispatchToolVisible({ ...baseInvocation, workjetRole: "standard" })).toBe(false);
  expect(isWorkerDispatchToolVisible({ ...baseInvocation, workjetRole: "worker" })).toBe(false);
  expect(isWorkerDispatchToolVisible(baseInvocation)).toBe(false);
});

it("declares the dispatch operation as destructive and non-idempotent", () => {
  expect(WorkerDispatchMcpTool.name).toBe(WORKJET_DISPATCH_WORKER_TOOL_NAME);
  expect(Context.get(WorkerDispatchMcpTool.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(WorkerDispatchMcpTool.annotations, Tool.Destructive)).toBe(true);
  expect(Context.get(WorkerDispatchMcpTool.annotations, Tool.Idempotent)).toBe(false);
  expect(Context.get(WorkerDispatchMcpTool.annotations, Tool.OpenWorld)).toBe(true);

  const schema = Tool.getJsonSchema(WorkerDispatchMcpTool) as {
    readonly additionalProperties?: boolean;
    readonly properties?: Record<string, unknown>;
  };
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties).toHaveProperty("task");
  expect(schema.properties).toHaveProperty("modelSelection");
});

it.effect("rejects unknown keys, malformed values, duplicates, and legacy model selections", () =>
  Effect.gen(function* () {
    const task = "TASK_CANARY_SHOULD_NOT_LEAK";
    const invalidPayloads = [
      { task, unknown: true },
      { task: "   " },
      { task: "x".repeat(32_001) },
      { task, title: "   " },
      { task, enabledCapabilityIds: ["greppy", "greppy"] },
      { task, enabledCapabilityIds: ["unknown-capability"] },
      { task, modelSelection: { provider: "codex", model: "gpt-5.4" } },
      {
        task,
        modelSelection: {
          instanceId: "codex-main",
          model: "gpt-5.4",
          options: [{ id: "effort", value: "high", unknown: true }],
        },
      },
    ];

    for (const payload of invalidPayloads) {
      const error = yield* decodeWorkerDispatchInput(payload).pipe(Effect.flip);
      expect(error).toBeInstanceOf(McpSchema.InvalidParams);
      expect(JSON.stringify(error)).not.toContain(task);
    }
  }),
);

it.effect("denies direct calls for standard, worker, and missing roles", () => {
  const dispatch = vi.fn(() => Effect.die("dispatch must not run"));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const workjetRole of ["standard", "worker", undefined] as const) {
      const invocation = {
        ...baseInvocation,
        ...(workjetRole === undefined ? {} : { workjetRole }),
      };
      const result = yield* server
        .callTool({
          name: WORKJET_DISPATCH_WORKER_TOOL_NAME,
          arguments: { task: "DENIED_TASK_CANARY" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          _tag: "WorkjetWorkerDispatchError",
          reason: "role-not-authorized",
        },
      });
      expect(JSON.stringify(result)).not.toContain("DENIED_TASK_CANARY");
    }
    expect(dispatch).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      makeTestLayer(
        WorkerDispatch.WorkerDispatch.of({ dispatch }) as WorkerDispatch.WorkerDispatchShape,
      ),
    ),
  );
});

it.effect("returns only the bounded dispatched result", () => {
  const task = "SUCCESS_TASK_CANARY";
  const dispatch = vi.fn(
    (
      _invocation: McpInvocationContext.McpInvocationScope,
      input: WorkerDispatch.WorkerDispatchInput,
    ) =>
      Effect.succeed({
        schemaVersion: 1 as const,
        status: "dispatched" as const,
        environmentId,
        workerThreadId: ThreadId.make("00000000-0000-4000-8000-000000000001"),
        parent: { environmentId, threadId },
        modelSelection:
          input.modelSelection ??
          ({
            instanceId: ProviderInstanceId.make("codex-main"),
            model: "gpt-5.4",
          } as const),
        enabledCapabilityIds: input.enabledCapabilityIds ?? [],
      }),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const invocation = { ...baseInvocation, workjetRole: "orchestrator" as const };
    const result = yield* server
      .callTool({
        name: WORKJET_DISPATCH_WORKER_TOOL_NAME,
        arguments: {
          task,
          enabledCapabilityIds: ["web-search"],
          modelSelection: {
            instanceId: "claude-team",
            model: "claude-opus-4-6",
            options: [{ id: "effort", value: "max" }],
          },
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      status: "dispatched",
      environmentId,
      workerThreadId: "00000000-0000-4000-8000-000000000001",
      parent: { environmentId, threadId },
      modelSelection: {
        instanceId: "claude-team",
        model: "claude-opus-4-6",
        options: [{ id: "effort", value: "max" }],
      },
      enabledCapabilityIds: ["web-search"],
    });
    expect(JSON.stringify(result)).not.toContain(task);
    expect(dispatch).toHaveBeenCalledOnce();
  }).pipe(
    Effect.provide(
      makeTestLayer(
        WorkerDispatch.WorkerDispatch.of({ dispatch }) as WorkerDispatch.WorkerDispatchShape,
      ),
    ),
  );
});

it.effect("keeps dispatch failures bounded and redacted", () => {
  const dispatch = () =>
    Effect.fail(new WorkerDispatch.WorkerDispatchError({ reason: "rollback-failed" }));
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: WORKJET_DISPATCH_WORKER_TOOL_NAME,
        arguments: { task: "FAILURE_TASK_CANARY" },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...baseInvocation,
          workjetRole: "orchestrator",
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { reason: "rollback-failed" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("FAILURE_TASK_CANARY");
    expect(JSON.stringify(result)).not.toContain("downstream");
  }).pipe(
    Effect.provide(
      makeTestLayer(
        WorkerDispatch.WorkerDispatch.of({ dispatch }) as WorkerDispatch.WorkerDispatchShape,
      ),
    ),
  );
});
