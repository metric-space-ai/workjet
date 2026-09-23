import { expect, it } from "@effect/vitest";
import { ThreadId, WorkjetConnectionId } from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration60 from "../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import migration61 from "../../persistence/Migrations/061_WorkjetCtoxNativeTurns.ts";
import { CtoxNativeRequests } from "./CtoxNativeRequests.ts";
import { makeCtoxNativeTaskClient } from "./CtoxNativeTaskClient.ts";
import type { makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";

it.effect(
  "learns a delayed native task once, survives reconstruction and permits its Crew claim",
  () =>
    Effect.gen(function* () {
      yield* migration60;
      yield* migration61;
      const requests = yield* CtoxNativeRequests.pipe(Effect.provide(CtoxNativeRequests.layer));
      const scope = {
        threadId: ThreadId.make("dev-thread"),
        connectionId: WorkjetConnectionId.make("connection"),
        instanceId: "instance",
      };
      const target = { endpoint: "https://ctox.example/mcp", token: "token" };
      let taskId: string | null = null;
      let commandId = "command";
      const receipt = {
        schema: "ctox.project_crew_request.v1",
        command_id: "command",
        thread_id: "workjet_private_chat",
        crew_member_id: "crew",
        executor_id: "computer",
        status: "accepted",
        task_id: null,
      };
      const transport: ReturnType<typeof makeCtoxMcpTransport> = {
        probe: () => Effect.succeed(undefined),
        callTool: (_, name) =>
          Effect.gen(function* () {
            if (name === "business_os.start_crew_execution") return { structuredContent: receipt };
            if (name === "business_os.get_command_status")
              return {
                structuredContent: {
                  ok: true,
                  record: {
                    id: commandId,
                    collection: "business_commands",
                    status: "accepted",
                    data: {
                      command_id: commandId,
                      task_id: taskId,
                      module: "ctox",
                      command_type: "business_os.chat.task",
                      status: "accepted",
                    },
                  },
                },
              };
            expect(name).toBe("business_os.claim_crew_execution");
            return {
              structuredContent: {
                schema: "ctox.external_crew_offer.v1",
                command_id: "command",
                attempt_id: "attempt",
                executor_id: "computer",
                harness: "codex",
                deadline_ms: (yield* Clock.currentTimeMillis) + 60_000,
                command_session: "signed-session",
                prompt: "Work",
                instructions: "Native instructions",
                crew_context: {
                  schema: "ctox.crew_context.v1",
                  command_id: "command",
                  attempt_id: "attempt",
                  task_id: "late-task",
                  module_id: "ctox",
                  member_id: "crew",
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
      const connections = { resolveReadyTarget: () => Effect.succeed(target) };
      const client = makeCtoxNativeTaskClient({ requests, connections, transport });
      const submitted = yield* client.submitProjectTurn(scope, "persisted-turn", {
        thread_id: "workjet_private_chat",
        title: "Work",
        instruction: "Work",
        harness: "codex",
        timeout_seconds: 60,
      });
      expect(submitted.reference.taskId).toBeNull();
      const turn = yield* client.latestNativeTurn(scope);
      expect(turn).not.toBeNull();
      if (!turn) return yield* Effect.die("Missing persisted turn");
      const identity = { ...scope, requestKey: turn.requestKey };
      expect((yield* client.readStatus(identity)).reference.taskId).toBeNull();
      taskId = "late-task";
      commandId = "foreign-command";
      expect(yield* Effect.flip(client.readStatus(identity))).toMatchObject({
        reason: "native-response-invalid",
      });
      expect((yield* requests.get(identity)).taskId).toBeNull();
      commandId = "command";
      expect((yield* client.readStatus(identity)).reference.taskId).toBe("late-task");
      // A stale acceptance retry must not erase the task learned from its command.
      yield* requests.recordReceipt(identity, receipt);
      const restoredRequests = yield* CtoxNativeRequests.pipe(
        Effect.provide(CtoxNativeRequests.layer),
      );
      const restored = makeCtoxNativeTaskClient({
        requests: restoredRequests,
        connections,
        transport,
      });
      expect((yield* restored.recover(identity)).taskId).toBe("late-task");
      expect(
        (yield* restored.claimProjectOffer(identity, "computer", "attempt")).context.task_id,
      ).toBe("late-task");
      taskId = "replacement-task";
      expect(yield* Effect.flip(restored.readStatus(identity))).toMatchObject({
        reason: "native-response-invalid",
      });
      expect(
        yield* Effect.flip(restoredRequests.recordObservedTask(identity, "command", taskId)),
      ).toMatchObject({ reason: "native-task-reference-conflict" });
      expect((yield* restored.recover(identity)).taskId).toBe("late-task");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
