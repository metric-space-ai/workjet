import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderOptionSelection,
  ThreadId,
  TrimmedNonEmptyString,
  WorkjetCapabilityId,
  WorkjetParentThreadReference,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkerDispatch from "../../../workjet/WorkerDispatch.ts";

export const WORKJET_DISPATCH_WORKER_TOOL_NAME = "workjet_dispatch_worker";

const NonBlankTask = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0 || "task must be nonblank"),
  Schema.isMaxLength(32_000),
);
const OptionalWorkerTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const DelegatedCapabilityIds = Schema.Array(WorkjetCapabilityId).check(
  Schema.makeFilter(
    (value) => new Set(value).size === value.length || "capability IDs must be unique",
  ),
);

export const CanonicalWorkerModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optional(Schema.Array(ProviderOptionSelection)),
});

export const WorkerDispatchInputSchema = Schema.Struct({
  task: NonBlankTask,
  title: Schema.optional(OptionalWorkerTitle),
  enabledCapabilityIds: Schema.optional(DelegatedCapabilityIds),
  modelSelection: Schema.optional(CanonicalWorkerModelSelection),
});

export const WorkerDispatchResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literal("dispatched"),
  environmentId: EnvironmentId,
  workerThreadId: ThreadId,
  parent: WorkjetParentThreadReference,
  modelSelection: CanonicalWorkerModelSelection,
  enabledCapabilityIds: Schema.Array(WorkjetCapabilityId),
});

const decodeWorkerDispatchInputSchema = Schema.decodeUnknownEffect(WorkerDispatchInputSchema, {
  onExcessProperty: "error",
});

export const decodeWorkerDispatchInput = (payload: unknown) =>
  decodeWorkerDispatchInputSchema(payload).pipe(
    Effect.mapError(
      () =>
        new McpSchema.InvalidParams({
          message: "Invalid Workjet worker dispatch input.",
        }),
    ),
  );

const enabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return Option.isSome(invocation) && isWorkerDispatchToolVisible(invocation.value);
};

export const WorkerDispatchMcpTool = Tool.make(WORKJET_DISPATCH_WORKER_TOOL_NAME, {
  description:
    "Create an ordinary local Workjet worker thread in this server environment and start its first T3 turn. The call returns immediately after dispatch and does not wait for completion.",
  parameters: WorkerDispatchInputSchema,
  success: WorkerDispatchResultSchema,
  dependencies: [McpInvocationContext.McpInvocationContext, WorkerDispatch.WorkerDispatch],
})
  .annotate(Tool.Title, "Dispatch Workjet worker")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, enabledWhen);

export const isWorkerDispatchToolVisible = (
  invocation: McpInvocationContext.McpInvocationScope,
): boolean => McpInvocationContext.isWorkjetOrchestrator(invocation);

const failureResult = (
  reason: WorkerDispatch.WorkerDispatchFailureReason,
): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: "WorkjetWorkerDispatchError",
        reason,
      },
    },
    content: [{ type: "text", text: "Workjet worker dispatch failed." }],
  });

const registerWorkerDispatch = Effect.fn("McpHttpServer.registerWorkerDispatch")(function* () {
  const server = yield* McpServer.McpServer;
  const workerDispatch = yield* WorkerDispatch.WorkerDispatch;
  const tool = WorkerDispatchMcpTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(WorkerDispatchResultSchema),
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
          yield* McpInvocationContext.requireWorkjetOrchestrator();
          const input = yield* decodeWorkerDispatchInput(payload);
          const modelSelection = input.modelSelection
            ? {
                instanceId: input.modelSelection.instanceId,
                model: input.modelSelection.model,
                ...(input.modelSelection.options !== undefined
                  ? { options: input.modelSelection.options }
                  : {}),
              }
            : undefined;
          const dispatchInput: WorkerDispatch.WorkerDispatchInput = {
            task: input.task,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.enabledCapabilityIds !== undefined
              ? { enabledCapabilityIds: input.enabledCapabilityIds }
              : {}),
            ...(modelSelection !== undefined ? { modelSelection } : {}),
          };
          const result = yield* workerDispatch.dispatch(invocation, dispatchInput);
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: result,
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- MCP text mirrors the validated structured result.
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTags({
            WorkjetOrchestratorUnavailableError: () =>
              Effect.succeed(failureResult("role-not-authorized")),
            WorkerDispatchError: (error) => Effect.succeed(failureResult(error.reason)),
          }),
        );
      }),
  });
});

export const WorkerToolkitRegistrationLive = Layer.effectDiscard(registerWorkerDispatch());
