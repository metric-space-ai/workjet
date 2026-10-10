// @effect-diagnostics preferSchemaOverJson:off -- MCP text mirrors validated structured content.
import { CommandId, ThreadId } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const WorkjetUpdateGoalInput = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["complete", "blocked"]),
    reason: Schema.String.check(
      Schema.makeFilter((text) => text.trim().length > 0 || "A verified result or exact blocker is required."),
      Schema.isMaxLength(8000),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("set"),
    threadId: ThreadId,
    objective: Schema.String.check(
      Schema.makeFilter((text) => text.trim().length > 0 || "An objective is required."),
      Schema.isMaxLength(4096),
    ),
    expectedRevision: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  }),
]);
const ResultSchema = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals(["active", "paused", "complete", "blocked"]),
  accepted: Schema.Literal(true),
});
const enabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const scope = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return Option.isSome(scope) && McpInvocationContext.isWorkjetMember(scope.value);
};
const tool = Tool.make("workjet_update_goal", {
  description:
    "Persistent workers report their own verified completion or concrete blocker. A project Supervisor uses action set with its bound persistent worker threadId and objective to assign/change a goal. Assignment preserves Owner-stopped states. No foreign project, one-shot worker or arbitrary thread access. Turn completion and ordinary resource waits are not completion or blockers.",
  parameters: WorkjetUpdateGoalInput,
  success: ResultSchema,
}).annotate(McpSchema.EnabledWhen, enabledWhen);

export const updateCurrentWorkerGoal = Effect.fn("workjet.updateCurrentWorkerGoal")(function* (
  input: typeof WorkjetUpdateGoalInput.Type,
) {
  const invocation = yield* McpInvocationContext.requireWorkjetMember();
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const found = yield* query.getThreadShellById(invocation.threadId);
  const config = Option.isSome(found) ? found.value.workjetConfig : undefined;
  if ("action" in input) {
    const supervisor = found;
    const target = yield* query.getThreadShellById(input.threadId);
    const callerTeam = config?.schemaVersion === 2 ? config.team : undefined;
    const targetConfig = Option.isSome(target) ? target.value.workjetConfig : undefined;
    const targetTeam = targetConfig?.schemaVersion === 2 ? targetConfig.team : undefined;
    if (
      Option.isNone(supervisor) || supervisor.value.deletedAt != null ||
      supervisor.value.archivedAt !== null || callerTeam?.role !== "supervisor" ||
      callerTeam.threadId !== invocation.threadId ||
      callerTeam.projectId !== supervisor.value.projectId ||
      Option.isNone(target) || target.value.deletedAt != null || target.value.archivedAt !== null ||
      targetTeam?.role !== "specialist" || targetTeam.threadId !== target.value.id ||
      target.value.projectId !== supervisor.value.projectId ||
      targetTeam.projectId !== supervisor.value.projectId ||
      targetTeam.parentThreadId !== invocation.threadId
    ) {
      return yield* new McpSchema.InvalidParams({
        message: "Only the current project Supervisor may set a bound persistent worker's goal.",
      });
    }
    const previous = targetConfig?.schemaVersion === 2 ? targetConfig.goal : undefined;
    if (input.expectedRevision !== undefined && input.expectedRevision !== previous?.revision) {
      return yield* new McpSchema.InvalidParams({ message: "The goal changed; read its current revision." });
    }
    // Assignment never resumes an Owner-stopped loop or erases its reason.
    const status = previous?.status ?? "active";
    const crypto = yield* Crypto.Crypto;
    yield* engine.dispatch({
      type: "thread.goal.assign",
      supervisorThreadId: invocation.threadId,
      commandId: CommandId.make(`server:supervisor-goal:${yield* crypto.randomUUIDv4}`),
      threadId: target.value.id, status, objective: input.objective.trim(),
      ...(previous ? { expectedRevision: previous.revision } : {}),
      ...(previous?.reason ? { reason: previous.reason } : {}),
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
    return { threadId: target.value.id, status, accepted: true as const };
  }
  if (
    Option.isNone(found) ||
    found.value.deletedAt != null ||
    found.value.archivedAt !== null ||
    config?.schemaVersion !== 2 ||
    config.team?.role !== "specialist" ||
    config.goal?.status !== "active"
  ) {
    return yield* new McpSchema.InvalidParams({
      message:
        "Only your current active persistent worker goal may be updated. An Owner-stopped goal stays stopped.",
    });
  }
  const crypto = yield* Crypto.Crypto;
  const uuid = yield* crypto.randomUUIDv4;
  yield* engine.dispatch({
    type: "thread.goal.set",
    commandId: CommandId.make(`server:goal-report:${uuid}`),
    threadId: invocation.threadId,
    status: input.status,
    reason: input.reason.trim(),
    expectedRevision: config.goal.revision,
    createdAt: DateTime.formatIso(yield* DateTime.now),
  });
  return { threadId: invocation.threadId, status: input.status, accepted: true as const };
});

const register = Effect.fn("McpHttpServer.registerWorkjetGoal")(function* () {
  const server = yield* McpServer.McpServer;
  const crypto = yield* Crypto.Crypto;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(ResultSchema),
      annotations: {
        title: "Update persistent worker goal",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        const engine = Context.getUnsafe(fiber.context, OrchestrationEngineService);
        const query = Context.getUnsafe(fiber.context, ProjectionSnapshotQuery);
        return Effect.gen(function* () {
          yield* McpInvocationContext.requireWorkjetMember();
          const input = yield* Schema.decodeUnknownEffect(WorkjetUpdateGoalInput, {
            onExcessProperty: "error",
          })(payload);
          const result = yield* updateCurrentWorkerGoal(input);
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ProjectionSnapshotQuery, query),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.catch(() =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                structuredContent: { error: "goal-update-rejected" },
                content: [
                  {
                    type: "text",
                    text: "Goal update rejected. Refresh the goal. Workers report only their active goal; Supervisors assign only their current project’s bound persistent workers. Owner-stopped loops stay stopped.",
                  },
                ],
              }),
            ),
          ),
        );
      }),
  });
});
export const GoalToolkitRegistrationLive = Layer.effectDiscard(register());
