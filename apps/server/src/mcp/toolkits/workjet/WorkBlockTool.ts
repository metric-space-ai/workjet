// @effect-diagnostics preferSchemaOverJson:off -- MCP text mirrors bounded validated structured content.
import { CommandId, EventId, type OrchestrationCommand, ThreadId } from "@t3tools/contracts";
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
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const WORKJET_RECORD_WORK_BLOCK_TOOL_NAME = "workjet_record_work_block";
export const WORKJET_WORK_BLOCK_ACTIVITY_KIND = "workjet-work-block";

const WorkBlockText = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0 || "value must be nonblank"),
  Schema.isMaxLength(8_000),
);

export const WorkjetRecordWorkBlockInput = Schema.Struct({
  topic: WorkBlockText,
  workPerformed: WorkBlockText,
  outcome: WorkBlockText,
  openPoints: Schema.optional(WorkBlockText),
  references: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(2_048))).check(Schema.isMaxLength(20)),
  ),
});

export const WorkjetRecordWorkBlockResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  activityId: EventId,
  threadId: ThreadId,
  startedAt: Schema.String,
  endedAt: Schema.String,
  durationMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  complete: Schema.Literal(true),
});

const enabledWhen = () => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const invocation = Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
  return Option.isSome(invocation) && McpInvocationContext.isWorkjetMember(invocation.value);
};

export const WorkjetRecordWorkBlockTool = Tool.make(WORKJET_RECORD_WORK_BLOCK_TOOL_NAME, {
  description:
    "Persist one worker-authored work block for the current continuous topic. Workjet supplies timestamps and duration; call once when work stops, changes topic, is handed off, or completes.",
  parameters: WorkjetRecordWorkBlockInput,
  success: WorkjetRecordWorkBlockResult,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    OrchestrationEngine.OrchestrationEngineService,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ],
})
  .annotate(Tool.Title, "Record Workjet work block")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, enabledWhen);

const payloadEndMillis = (payload: unknown): number | undefined => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const endedAt = "endedAt" in payload ? payload.endedAt : undefined;
  if (typeof endedAt !== "string") return undefined;
  const millis = Date.parse(endedAt);
  return Number.isFinite(millis) ? millis : undefined;
};

export const resolveWorkBlockStartMillis = (
  issuedAt: number,
  endedMillis: number,
  priorPayloads: ReadonlyArray<unknown>,
): number => {
  const priorEndMillis = [...priorPayloads]
    .reverse()
    .map(payloadEndMillis)
    .find((millis) => millis !== undefined);
  return Math.min(endedMillis, Math.max(issuedAt, priorEndMillis ?? issuedAt));
};

const register = Effect.fn("McpHttpServer.registerWorkjetWorkBlock")(function* () {
  const server = yield* McpServer.McpServer;
  const crypto = yield* Crypto.Crypto;
  const tool = WorkjetRecordWorkBlockTool;

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      outputSchema: Tool.getJsonSchemaFromSchema(WorkjetRecordWorkBlockResult),
      annotations: {
        title: "Record Workjet work block",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
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
        const engine = Context.getUnsafe(
          fiber.context,
          OrchestrationEngine.OrchestrationEngineService,
        );
        const query = Context.getUnsafe(
          fiber.context,
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        );
        return Effect.gen(function* () {
          yield* McpInvocationContext.requireWorkjetMember();
          const input = yield* Schema.decodeUnknownEffect(WorkjetRecordWorkBlockInput, {
            onExcessProperty: "error",
          })(payload).pipe(
            Effect.mapError(
              () => new McpSchema.InvalidParams({ message: "Invalid Workjet work block." }),
            ),
          );
          const thread = yield* query
            .getThreadDetailById(invocation.threadId)
            .pipe(
              Effect.mapError(
                () => new McpSchema.InternalError({ message: "Workjet thread read failed." }),
              ),
            );
          if (Option.isNone(thread) || thread.value.deletedAt !== null) {
            return new McpSchema.CallToolResult({
              isError: true,
              structuredContent: { error: "thread-unavailable" },
              content: [{ type: "text", text: "The current Workjet thread is unavailable." }],
            });
          }

          const endedAt = DateTime.formatIso(yield* DateTime.now);
          const endedMillis = Date.parse(endedAt);
          const startedMillis = resolveWorkBlockStartMillis(
            invocation.issuedAt,
            endedMillis,
            thread.value.activities
              .filter((activity) => activity.kind === WORKJET_WORK_BLOCK_ACTIVITY_KIND)
              .map((activity) => activity.payload),
          );
          const startedAt = DateTime.formatIso(DateTime.makeUnsafe(startedMillis));
          const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const activityId = EventId.make(`workjet-work-block:${uuid}`);
          const command: OrchestrationCommand = {
            type: "thread.activity.append",
            commandId: CommandId.make(`server:workjet-work-block:${uuid}`),
            threadId: invocation.threadId,
            activity: {
              id: activityId,
              tone: "info",
              kind: WORKJET_WORK_BLOCK_ACTIVITY_KIND,
              summary: input.topic.trim(),
              payload: {
                schemaVersion: 1,
                topic: input.topic.trim(),
                workPerformed: input.workPerformed.trim(),
                outcome: input.outcome.trim(),
                openPoints: input.openPoints?.trim() ?? null,
                references: input.references ?? [],
                authorThreadId: invocation.threadId,
                providerInstanceId: invocation.providerInstanceId,
                startedAt,
                endedAt,
                durationMs: Math.max(0, endedMillis - startedMillis),
                complete: true,
              },
              turnId: null,
              createdAt: endedAt,
            },
            createdAt: endedAt,
          };
          yield* engine
            .dispatch(command)
            .pipe(
              Effect.mapError(
                () => new McpSchema.InternalError({ message: "Work block persistence failed." }),
              ),
            );
          const result = {
            schemaVersion: 1 as const,
            activityId,
            threadId: invocation.threadId,
            startedAt,
            endedAt,
            durationMs: Math.max(0, endedMillis - startedMillis),
            complete: true as const,
          };
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.catchTag("WorkjetMemberUnavailableError", () =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                structuredContent: { error: "not-a-workjet-member" },
                content: [{ type: "text", text: "Work block recording unavailable." }],
              }),
            ),
          ),
        );
      }),
  });
});

export const WorkBlockToolkitRegistrationLive = Layer.effectDiscard(register());
