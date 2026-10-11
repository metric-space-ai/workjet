import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import {
  WorkerSupervisorAnswer,
  answerWorkerDecision,
} from "../../../workjet/WorkerSupervisorDecisions.ts";

const tool = Tool.make("workjet_answer_worker", {
  description:
    "The bound project Supervisor answers a worker question or approval and resumes its original pending provider request. Use the decisionId received in your Supervisor chat, with answers keyed by question ID or decision accept/acceptForSession/decline/cancel. Workers cannot answer or escalate to the Owner through this tool.",
  parameters: WorkerSupervisorAnswer,
  success: Schema.Unknown,
}).annotate(McpSchema.EnabledWhen, () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext);
  return Option.isSome(invocation) && invocation.value.projectTeamRole === "supervisor";
});
const register = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const sql = Context.getUnsafe(fiber.context, SqlClient.SqlClient);
        const query = Context.getUnsafe(fiber.context, ProjectionSnapshotQuery);
        const providers = Context.getUnsafe(fiber.context, ProviderService);
        const invocation = Context.getUnsafe(fiber.context, McpInvocationContext);
        return Effect.gen(function* () {
          const input = yield* Schema.decodeUnknownEffect(WorkerSupervisorAnswer)(payload);
          const result = yield* answerWorkerDecision(invocation.threadId, input);
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: result,
            content: [
              {
                type: "text",
                text: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result),
              },
            ],
          });
        }).pipe(
          Effect.provide(fiber.context),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ProjectionSnapshotQuery, query),
          Effect.provideService(ProviderService, providers),
          Effect.catch((error) =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                content: [{ type: "text", text: String(error) }],
              }),
            ),
          ),
        );
      }),
  });
});
export const WorkerDecisionToolkitRegistrationLive = Layer.effectDiscard(register);
