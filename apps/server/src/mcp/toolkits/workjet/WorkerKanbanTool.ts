// @effect-diagnostics preferSchemaOverJson:off -- MCP text mirrors validated structured content.
import {
  CommandId,
  ThreadId,
  WorkjetWorkerKanban,
  WorkjetWorkerKanbanCard,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import * as Invocation from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const WorkerKanbanInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("update"),
    cards: Schema.Array(WorkjetWorkerKanbanCard).check(Schema.isMaxLength(30)),
  }),
  Schema.Struct({ action: Schema.Literal("project") }),
]);
const result = Schema.Struct({
  threadId: ThreadId,
  accepted: Schema.optional(Schema.Boolean),
  workers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        title: Schema.String,
        objective: Schema.String,
        kanban: Schema.NullOr(WorkjetWorkerKanban),
      }),
    ),
  ),
});
const tool = Tool.make("workjet_worker_kanban", {
  description:
    "Persistent parents update their own compact mini-kanban before any other work at each goal-loop iteration (todo/doing/done/blocked, optional evidence). Supervisors read their project's parent snapshots with action project. No caller can select another thread/project; one-shot workers do not maintain boards.",
  parameters: WorkerKanbanInput,
  success: result,
}).annotate(McpSchema.EnabledWhen, () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const found = Context.getOption(fiber.context, Invocation.McpInvocationContext);
  return Option.isSome(found) && Invocation.isWorkjetMember(found.value);
});

export const operateWorkerKanban = Effect.fn("workjet.operateWorkerKanban")(function* (
  input: typeof WorkerKanbanInput.Type,
) {
  const invocation = yield* Invocation.requireWorkjetMember();
  const query = yield* ProjectionSnapshotQuery;
  const found = yield* query.getThreadShellById(invocation.threadId);
  if (
    Option.isNone(found) ||
    found.value.deletedAt != null ||
    found.value.archivedAt !== null ||
    found.value.workjetConfig.schemaVersion !== 2
  )
    return yield* new McpSchema.InvalidParams({
      message: "A current active project team thread is required.",
    });
  const thread = found.value;
  const config = thread.workjetConfig;
  if (config.schemaVersion !== 2) return yield* Effect.die("config narrowing failed");
  if (input.action === "project") {
    if (config.team?.role !== "supervisor")
      return yield* new McpSchema.InvalidParams({
        message: "Only the project's supervisor may read its parent boards.",
      });
    const snapshot = yield* query.getCommandReadModel();
    return {
      threadId: thread.id,
      workers: snapshot.threads.flatMap((parent) => {
        const cfg = parent.workjetConfig;
        return parent.projectId === thread.projectId &&
          parent.archivedAt === null &&
          parent.deletedAt === null &&
          cfg.schemaVersion === 2 &&
          cfg.team?.role === "specialist" &&
          cfg.team.parentThreadId === thread.id
          ? [
              {
                threadId: parent.id,
                title: parent.title,
                objective: cfg.goal?.objective ?? cfg.team.goal,
                kanban: cfg.goal?.kanban ?? null,
              },
            ]
          : [];
      }),
    };
  }
  if (config.team?.role !== "specialist" || config.goal?.status !== "active")
    return yield* new McpSchema.InvalidParams({
      message: "Only your own active persistent-worker goal has a mini-kanban.",
    });
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const at = DateTime.formatIso(yield* DateTime.now);
  yield* engine.dispatch({
    type: "thread.worker-kanban.set",
    commandId: CommandId.make(`server:worker-kanban:${yield* crypto.randomUUIDv4}`),
    threadId: thread.id,
    createdAt: at,
    kanban: {
      goalRevision: config.goal.revision,
      iteration: config.goal.continuationCount,
      cards: input.cards,
      updatedAt: at,
    },
  });
  return { threadId: thread.id, accepted: true };
});
const register = Effect.fn("McpHttpServer.registerWorkerKanban")(function* () {
  const server = yield* McpServer.McpServer;
  const crypto = yield* Crypto.Crypto;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(result),
      annotations: {
        title: "Persistent worker mini-kanban",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(fiber.context, Invocation.McpInvocationContext);
        const engine = Context.getUnsafe(fiber.context, OrchestrationEngineService);
        const query = Context.getUnsafe(fiber.context, ProjectionSnapshotQuery);
        return Effect.gen(function* () {
          yield* Invocation.requireWorkjetMember();
          const input = yield* Schema.decodeUnknownEffect(WorkerKanbanInput, {
            onExcessProperty: "error",
          })(payload);
          const output = yield* operateWorkerKanban(input);
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: output,
            content: [{ type: "text", text: JSON.stringify(output) }],
          });
        }).pipe(
          Effect.provideService(Invocation.McpInvocationContext, invocation),
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ProjectionSnapshotQuery, query),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.catch(() =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "Mini-kanban action rejected. Parents update their own active goal; supervisors read only their bound project.",
                  },
                ],
              }),
            ),
          ),
        );
      }),
  });
});
export const WorkerKanbanToolkitRegistrationLive = Layer.effectDiscard(register());
