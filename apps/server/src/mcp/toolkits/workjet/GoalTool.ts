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

export const WorkjetUpdateGoalInput = Schema.Struct({
  status: Schema.Literals(["complete", "blocked"]),
  reason: Schema.String.check(Schema.makeFilter((text) => text.trim().length > 0 || "A verified result or exact blocker is required."), Schema.isMaxLength(8000)),
});
const ResultSchema = Schema.Struct({ threadId: ThreadId, status: Schema.Literals(["complete", "blocked"]), accepted: Schema.Literal(true) });
const enabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const scope = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return Option.isSome(scope) && McpInvocationContext.isWorkjetMember(scope.value);
};
const tool = Tool.make("workjet_update_goal", {
  description: "Mark your own persistent worker goal complete with verified results/evidence, or blocked with a concrete missing external decision. Turn completion and ordinary resource waits are not goal completion or blockers. Cannot resume an Owner-stopped goal or update another thread.",
  parameters: WorkjetUpdateGoalInput, success: ResultSchema,
}).annotate(McpSchema.EnabledWhen, enabledWhen);

export const updateCurrentWorkerGoal = Effect.fn("workjet.updateCurrentWorkerGoal")(function* (input: typeof WorkjetUpdateGoalInput.Type) {
  const invocation = yield* McpInvocationContext.requireWorkjetMember();
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const found = yield* query.getThreadShellById(invocation.threadId);
  const config = Option.isSome(found) ? found.value.workjetConfig : undefined;
  if (Option.isNone(found) || found.value.deletedAt != null || found.value.archivedAt !== null ||
    config?.schemaVersion !== 2 || config.team?.role !== "specialist" || config.goal?.status !== "active") {
    return yield* new McpSchema.InvalidParams({ message: "Only your current active persistent worker goal may be updated. An Owner-stopped goal stays stopped." });
  }
  const crypto = yield* Crypto.Crypto;
  const uuid = yield* crypto.randomUUIDv4;
  yield* engine.dispatch({
    type: "thread.goal.set", commandId: CommandId.make(`server:goal-report:${uuid}`),
    threadId: invocation.threadId, status: input.status, reason: input.reason.trim(),
    expectedRevision: config.goal.revision, createdAt: DateTime.formatIso(yield* DateTime.now),
  });
  return { threadId: invocation.threadId, status: input.status, accepted: true as const };
});

const register = Effect.fn("McpHttpServer.registerWorkjetGoal")(function* () {
  const server = yield* McpServer.McpServer;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name, description: Tool.getDescription(tool), inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(ResultSchema),
      annotations: { title: "Update persistent worker goal", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }),
    annotations: tool.annotations,
    handle: (payload) => Effect.withFiber((fiber) => {
      const invocation = Context.getUnsafe(fiber.context, McpInvocationContext.McpInvocationContext);
      const engine = Context.getUnsafe(fiber.context, OrchestrationEngineService);
      const query = Context.getUnsafe(fiber.context, ProjectionSnapshotQuery);
      return Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(WorkjetUpdateGoalInput, { onExcessProperty: "error" })(payload);
        const result = yield* updateCurrentWorkerGoal(input);
        return new McpSchema.CallToolResult({ isError: false, structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] });
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(OrchestrationEngineService, engine),
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.catch(() => Effect.succeed(new McpSchema.CallToolResult({
          isError: true, structuredContent: { error: "goal-update-rejected" },
          content: [{ type: "text", text: "Goal update rejected. Refresh the current goal; only an active persistent worker may record a verified result or exact blocker." }],
        }))),
      );
    }),
  });
});
export const GoalToolkitRegistrationLive = Layer.effectDiscard(register());
