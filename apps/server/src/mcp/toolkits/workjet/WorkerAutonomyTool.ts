import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandId, MessageId, EventId } from "@workjet/contracts";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import {
  WorkjetEscalation,
  escalateWorkjetDecision,
  WorkerSupervisorDecisionError,
} from "../../../workjet/WorkerSupervisorDecisions.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const enabled = (escalation: boolean) => () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext);
  return (
    Option.isSome(invocation) &&
    (escalation
      ? invocation.value.projectTeamRole === "supervisor" ||
        invocation.value.projectTeamRole === "specialist"
      : invocation.value.projectTeamRole === "specialist" ||
        invocation.value.projectTeamRole === "worker")
  );
};
const escalation = Tool.make("workjet_escalate", {
  description:
    "Persistent workers ask only their project Supervisor. The Supervisor decides from project context first and uses this tool for the Owner only for an unavoidable Owner decision, money, legal matter or credentials. One-Shots cannot use this tool.",
  parameters: WorkjetEscalation,
  success: Schema.Unknown,
}).annotate(McpSchema.EnabledWhen, enabled(true));
const resultInput = Schema.Struct({
  summary: Schema.String,
  pullRequestUrl: Schema.optional(Schema.String),
});
const resultTool = Tool.make("workjet_submit_worker", {
  description:
    "Report the worker result, PR URL and any unresolved point to the project Supervisor. Finish your run after submitting. This reports the result; the existing PR lifecycle controls archival.",
  parameters: resultInput,
  success: Schema.Unknown,
}).annotate(McpSchema.EnabledWhen, enabled(false));
const submit = Effect.fn("workjet.submitWorkerResult")(function* (input: typeof resultInput.Type) {
  const invocation = yield* McpInvocationContext;
  if (invocation.projectTeamRole !== "worker" && invocation.projectTeamRole !== "specialist")
    return yield* new WorkerSupervisorDecisionError({
      message: "Only project workers submit worker results.",
    });
  const query = yield* ProjectionSnapshotQuery;
  const found = yield* query.getThreadShellById(invocation.threadId);
  if (Option.isNone(found) || found.value.workjetConfig.schemaVersion !== 2)
    return yield* new WorkerSupervisorDecisionError({ message: "Worker thread is unavailable." });
  const thread = found.value;
  const parentId = found.value.workjetConfig.team?.parentThreadId;
  const engine = yield* OrchestrationEngineService;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const id = `server:worker-result:${yield* (yield* Crypto.Crypto).randomUUIDv4}`;
  const text = `Worker ${thread.id}: ${input.summary}${input.pullRequestUrl ? "\nPR: " + input.pullRequestUrl : ""}`;
  yield* engine.dispatch({
    type: "thread.activity.append",
    commandId: CommandId.make(id),
    threadId: thread.id,
    activity: {
      id: EventId.make(id),
      turnId: null,
      kind: "workjet.worker.result",
      summary: input.summary,
      tone: "info",
      payload: { ...input, workerThreadId: thread.id },
      createdAt,
    },
    createdAt,
  });
  if (parentId) {
    const parent = yield* query.getThreadShellById(parentId);
    if (Option.isSome(parent))
      yield* engine.dispatch(
        {
          type: "thread.turn.start",
          commandId: CommandId.make(id + ":parent"),
          threadId: parent.value.id,
          message: {
            messageId: MessageId.make(id + ":parent"),
            role: "user",
            attachments: [],
            text,
          },
          runtimeMode: parent.value.runtimeMode,
          interactionMode: parent.value.interactionMode,
          createdAt,
        },
        { deferWhileBusy: true },
      );
  }
  return { accepted: true, reportedTo: parentId ?? null };
});
export const WorkerAutonomyToolkitRegistrationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const tool of [escalation, resultTool])
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: Tool.getJsonSchema(tool),
        }),
        annotations: tool.annotations,
        handle: (payload) =>
          Effect.withFiber((fiber) =>
            Effect.gen(function* () {
              const invocation = yield* McpInvocationContext;
              const result =
                tool.name === "workjet_escalate"
                  ? yield* escalateWorkjetDecision(
                      invocation.threadId,
                      yield* Schema.decodeUnknownEffect(WorkjetEscalation)(payload),
                    )
                  : yield* submit(yield* Schema.decodeUnknownEffect(resultInput)(payload));
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
              Effect.provideService(
                McpInvocationContext,
                Context.getUnsafe(fiber.context, McpInvocationContext),
              ),
              Effect.provideService(
                ProjectionSnapshotQuery,
                Context.getUnsafe(fiber.context, ProjectionSnapshotQuery),
              ),
              Effect.provideService(
                OrchestrationEngineService,
                Context.getUnsafe(fiber.context, OrchestrationEngineService),
              ),
              Effect.provideService(
                SqlClient.SqlClient,
                Context.getUnsafe(fiber.context, SqlClient.SqlClient),
              ),
              Effect.provideService(Crypto.Crypto, Context.getUnsafe(fiber.context, Crypto.Crypto)),
              Effect.catch((error) =>
                Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: true,
                    content: [{ type: "text", text: String(error) }],
                  }),
                ),
              ),
            ),
          ),
      });
  }),
);
