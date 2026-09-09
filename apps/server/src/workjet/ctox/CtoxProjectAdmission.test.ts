import { expect, it } from "@effect/vitest";
import { ThreadId, WorkjetConnectionId, type WorkjetCtoxCrewOffers } from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration60 from "../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import migration61 from "../../persistence/Migrations/061_WorkjetCtoxNativeTurns.ts";
import { CtoxNativeRequests } from "./CtoxNativeRequests.ts";
import { makeCtoxNativeTaskClient } from "./CtoxNativeTaskClient.ts";
import type { makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";

it.effect("keeps pending, review and resume separate and claims only one new native offer", () =>
  Effect.gen(function* () {
    yield* migration60;
    yield* migration61;
    const requests = yield* CtoxNativeRequests.pipe(Effect.provide(CtoxNativeRequests.layer));
    const scope = {
      threadId: ThreadId.make("dev"),
      connectionId: WorkjetConnectionId.make("connection"),
      instanceId: "instance",
    };
    const task = {
      thread_id: "workjet_private_chat",
      title: "Work",
      instruction: "Work",
      harness: "codex" as const,
      timeout_seconds: 60,
    };
    const deadline = (yield* Clock.currentTimeMillis) + 60_000;
    let taskId: string | null = null;
    let status = "accepted";
    let offers: Array<(typeof WorkjetCtoxCrewOffers.Type)["offers"][number]> = [];
    let memberId = "crew";
    let claims = 0;
    const sentKeys: string[] = [];
    const transport: ReturnType<typeof makeCtoxMcpTransport> = {
      probe: () => Effect.succeed(undefined),
      callTool: (_, name, args) =>
        Effect.gen(function* () {
          if (name === "business_os.start_crew_execution") {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ idempotency_key: Schema.String }),
            )(args);
            sentKeys.push(input.idempotency_key);
            return {
              structuredContent: {
                schema: "ctox.project_crew_request.v1",
                command_id: "command",
                thread_id: task.thread_id,
                crew_member_id: "crew",
                executor_id: "computer",
                status: "accepted",
                task_id: null,
              },
            };
          }
          if (name === "business_os.get_command_status")
            return {
              structuredContent: {
                ok: true,
                record: {
                  id: "command",
                  collection: "business_commands",
                  status,
                  data: {
                    command_id: "command",
                    task_id: taskId,
                    module: "ctox",
                    command_type: "business_os.chat.task",
                    status,
                  },
                },
              },
            };
          if (name === "business_os.list_crew_executions") {
            expect(args).toEqual({ command_id: "command", executor_id: "computer" });
            return {
              structuredContent: {
                schema: "ctox.external_crew_executions.v1",
                command_id: "command",
                executor_id: "computer",
                offers,
              },
            };
          }
          expect(name).toBe("business_os.claim_crew_execution");
          expect(args).toEqual({
            command_id: "command",
            executor_id: "computer",
            attempt_id: "attempt",
          });
          claims++;
          return {
            structuredContent: {
              schema: "ctox.external_crew_offer.v1",
              command_id: "command",
              attempt_id: "attempt",
              executor_id: "computer",
              harness: "codex",
              deadline_ms: deadline,
              command_session: "signed",
              prompt: "Native work",
              instructions: "Native rules",
              crew_context: {
                schema: "ctox.crew_context.v1",
                command_id: "command",
                attempt_id: "attempt",
                task_id: "task",
                module_id: "ctox",
                member_id: memberId,
                member_name: "Crew",
                persona: "Persona",
                memory_block: null,
                execution_plan: null,
                context_version: "v1",
              },
            },
          };
        }),
    };
    const client = makeCtoxNativeTaskClient({
      requests,
      transport,
      connections: {
        resolveReadyTarget: () =>
          Effect.succeed({ endpoint: "https://ctox.example/mcp", token: "token" }),
      },
    });
    const prepare = () => client.prepareProjectExecution(scope, "persisted-event", task);
    expect((yield* prepare()).state).toBe("awaiting-native-task");
    taskId = "task";
    expect((yield* prepare()).state).toBe("awaiting-native-offer");
    const offered = {
      attempt_id: "attempt",
      harness: "codex" as const,
      deadline_ms: deadline,
      state: "offered" as const,
    };
    offers = [{ ...offered, state: "reported" }];
    expect((yield* prepare()).state).toBe("awaiting-native-review");
    offers = [{ ...offered, state: "claimed" }];
    expect((yield* prepare()).state).toBe("resume-required");
    offers = [offered, { ...offered, attempt_id: "second" }];
    expect(yield* Effect.flip(prepare())).toMatchObject({ reason: "native-response-invalid" });
    expect(claims).toBe(0);
    offers = [offered];
    const admitted = yield* prepare();
    expect(admitted.state).toBe("ready");
    if (admitted.state !== "ready") return yield* Effect.die("Expected native admission");
    expect(admitted.claim.context.member_id).toBe("crew");
    expect(admitted.observed.reference.taskId).toBe("task");
    expect(claims).toBe(1);
    memberId = "other-crew";
    expect(yield* Effect.flip(prepare())).toMatchObject({ reason: "native-response-invalid" });
    status = "completed";
    expect((yield* prepare()).state).toBe("native-terminal");
    expect(claims).toBe(2);
    expect(new Set(sentKeys).size).toBe(1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
