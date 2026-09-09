import { expect, it } from "@effect/vitest";
import { ThreadId, WorkjetConnectionId, WorkjetCtoxCrewRequest } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration60 from "../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import migration61 from "../../persistence/Migrations/061_WorkjetCtoxNativeTurns.ts";
import { CtoxNativeRequests } from "./CtoxNativeRequests.ts";
import { CtoxMcpTransportError, type makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import { makeCtoxNativeTaskClient } from "./CtoxNativeTaskClient.ts";

it.effect("recovers project submission after a lost receipt and rejects another private chat", () =>
  Effect.gen(function* () {
    yield* migration60;
    yield* migration61;
    const scope = {
      threadId: ThreadId.make("dev-thread"),
      connectionId: WorkjetConnectionId.make("connection"),
      instanceId: "instance",
    };
    const task = {
      thread_id: "workjet_private_chat",
      title: "Implement",
      instruction: "Implement the task",
      harness: "codex" as const,
      timeout_seconds: 60,
    };
    const sent: string[] = [];
    let lose = true;
    let wrongChat = false;
    const transport: ReturnType<typeof makeCtoxMcpTransport> = {
      probe: (_, names, fields) =>
        Effect.sync(() => {
          expect(names).toEqual(["business_os.start_crew_execution"]);
          expect(fields).toEqual({ "business_os.start_crew_execution": ["idempotency_key"] });
          return undefined;
        }),
      callTool: (_, name, args) =>
        Effect.gen(function* () {
          expect(name).toBe("business_os.start_crew_execution");
          const request = yield* Schema.decodeUnknownEffect(WorkjetCtoxCrewRequest)({
            ...args,
            operation: "start_crew_execution",
          }).pipe(Effect.orDie);
          expect(args).not.toHaveProperty("module_id");
          expect(args).not.toHaveProperty("crew_member_id");
          expect(args).not.toHaveProperty("executor_id");
          sent.push(request.idempotency_key);
          if (lose) {
            lose = false;
            return yield* new CtoxMcpTransportError({ reason: "connection-unavailable" });
          }
          return {
            structuredContent: {
              schema: "ctox.project_crew_request.v1",
              command_id: "command",
              task_id: "task",
              thread_id: wrongChat ? "workjet_private_other" : request.thread_id,
              crew_member_id: "crew",
              executor_id: "computer",
              status: "accepted",
            },
          };
        }),
    };
    let target = { endpoint: "https://ctox.example/mcp", token: "fixture" };
    const connections = { resolveReadyTarget: () => Effect.succeed(target) };
    const open = CtoxNativeRequests.pipe(Effect.provide(CtoxNativeRequests.layer));
    const first = makeCtoxNativeTaskClient({ requests: yield* open, connections, transport });
    expect(yield* Effect.flip(first.submitProjectTurn(scope, "event-1", task))).toMatchObject({
      reason: "connection-unavailable",
    });
    expect(sent).toHaveLength(1);
    const pending = yield* first.latestNativeTurn(scope);
    expect(pending?.reference.commandId).toBeNull();
    const restarted = makeCtoxNativeTaskClient({ requests: yield* open, connections, transport });
    const result = yield* restarted.submitProjectTurn(scope, "event-1", task);
    expect(sent[1]).toBe(sent[0]);
    expect(result.reference).toMatchObject({
      commandId: "command",
      taskId: "task",
      request: { thread_id: task.thread_id },
    });
    expect(
      yield* Effect.flip(
        restarted.submitProjectTurn(scope, "event-1", { ...task, instruction: "Changed" }),
      ),
    ).toMatchObject({ reason: "native-request-conflict" });
    expect(sent).toHaveLength(2);
    const identity = { ...scope, requestKey: result.reference.request.idempotency_key };
    for (const changed of [
      { endpoint: target.endpoint, token: "another-principal" },
      { endpoint: "https://other.example/mcp", token: "fixture" },
    ]) {
      target = changed;
      expect(yield* Effect.flip(restarted.readStatus(identity))).toMatchObject({
        reason: "native-request-credentials-changed",
      });
      expect(sent).toHaveLength(2);
    }
    target = { endpoint: "https://ctox.example/mcp", token: "fixture" };
    wrongChat = true;
    expect(yield* Effect.flip(restarted.submitProjectTurn(scope, "event-2", task))).toMatchObject({
      reason: "native-response-invalid",
    });
    expect((yield* restarted.latestNativeTurn(scope))?.reference.commandId).toBeNull();
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
