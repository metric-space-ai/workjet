import { expect, it } from "@effect/vitest";
import {
  ThreadId,
  WorkjetConnectionId,
  WorkjetDecisionHubConnectionError,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration60 from "../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import migration61 from "../../persistence/Migrations/061_WorkjetCtoxNativeTurns.ts";
import { CtoxNativeRequests } from "./CtoxNativeRequests.ts";
import { CtoxMcpTransportError, type makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import { makeCtoxNativeTaskClient } from "./CtoxNativeTaskClient.ts";

const scope = {
  threadId: ThreadId.make("native-thread"),
  connectionId: WorkjetConnectionId.make("native-connection"),
  instanceId: "instance-a",
};
const task = { module_id: "inventory", title: "Review", objective: "Review inventory" };
const target = { endpoint: "https://mcp.ctox.dev/mcp/instance-a", token: "test-token" };
const Args = Schema.Struct({
  idempotency_key: Schema.String,
  action_id: Schema.Literal("ctox.delegate_task"),
});
const decodeArgs = Schema.decodeUnknownEffect(Args);
const openRequests = CtoxNativeRequests.pipe(Effect.provide(CtoxNativeRequests.layer));

it.effect(
  "recovers a native turn after the accepted response is lost and keeps distinct intents separate",
  () =>
    Effect.gen(function* () {
      yield* migration60;
      yield* migration61;
      const sent: string[] = [];
      const nativeTasks = new Map<
        string,
        { module_id: string; command_type: string; command_id: string; task_id: string }
      >();
      let loseResponse = true;
      const transport: ReturnType<typeof makeCtoxMcpTransport> = {
        probe: (_, tools, fields) =>
          Effect.sync(() => {
            expect(tools).toEqual(["business_os.execute_action"]);
            expect(fields).toEqual({ "business_os.execute_action": ["idempotency_key"] });
            // The real probe falls off the end of its generator, so the contract's
            // success type is `undefined`, not `void`. A callback returning `void`
            // is not assignable to it — return the value the transport really has.
            return undefined;
          }),
        callTool: (_, name, args) =>
          Effect.gen(function* () {
            expect(name).toBe("business_os.execute_action");
            const decoded = yield* decodeArgs(args).pipe(Effect.orDie);
            sent.push(decoded.idempotency_key);
            let receipt = nativeTasks.get(decoded.idempotency_key);
            if (!receipt) {
              receipt = {
                module_id: task.module_id,
                command_type: "ctox.delegate_task",
                command_id: `cmd-${nativeTasks.size}`,
                task_id: `task-${nativeTasks.size}`,
              };
              nativeTasks.set(decoded.idempotency_key, receipt);
            }
            if (loseResponse) {
              loseResponse = false;
              return yield* new CtoxMcpTransportError({ reason: "connection-unavailable" });
            }
            return { structuredContent: receipt };
          }),
      };
      const connections = {
        resolveReadyTarget: (connection: WorkjetConnectionId, instance?: string) => {
          if (connection !== scope.connectionId || instance !== scope.instanceId)
            return Effect.fail(
              new WorkjetDecisionHubConnectionError({ reason: "connection-instance-mismatch" }),
            );
          return Effect.succeed(target);
        },
      };
      const first = makeCtoxNativeTaskClient({
        requests: yield* openRequests,
        connections,
        transport,
      });
      expect(yield* Effect.flip(first.submitTurn(scope, "command:turn-1", task))).toMatchObject({
        reason: "connection-unavailable",
      });
      expect(nativeTasks.size).toBe(1);
      expect(sent).toHaveLength(1); // No automatic retry after an uncertain write.

      // Reconstruct both layers using the same database, as after server restart.
      const restarted = makeCtoxNativeTaskClient({
        requests: yield* openRequests,
        connections,
        transport,
      });
      const recovered = yield* restarted.submitTurn(scope, "command:turn-1", task);
      expect(nativeTasks.size).toBe(1);
      expect(sent[1]).toBe(sent[0]);
      expect(recovered.reference).toMatchObject({
        commandId: "cmd-0",
        taskId: "task-0",
        instanceId: scope.instanceId,
      });
      expect(
        yield* Effect.flip(
          restarted.submitTurn(scope, "command:turn-1", { ...task, objective: "Changed intent" }),
        ),
      ).toMatchObject({ reason: "native-request-conflict" });
      expect(sent).toHaveLength(2);
      expect(
        yield* Effect.flip(
          restarted.submitTurn({ ...scope, instanceId: "instance-b" }, "command:turn-1", task),
        ),
      ).toMatchObject({ reason: "connection-instance-mismatch" });
      expect(sent).toHaveLength(2);
      const separate = yield* restarted.submitTurn(scope, "command:turn-2", task);
      expect(nativeTasks.size).toBe(2);
      expect(separate.reference.taskId).not.toBe(recovered.reference.taskId);
      expect(yield* Effect.flip(restarted.submitTurn(scope, "", task))).toMatchObject({
        reason: "native-request-conflict",
      });
      expect(sent).toHaveLength(3);
      const latest = yield* restarted.latestNativeTurn(scope);
      expect(latest).toMatchObject({
        requestId: "command:turn-2",
        reference: { taskId: separate.reference.taskId },
      });
      yield* restarted.submit(
        { ...scope, requestKey: "external-tool" },
        {
          ...task,
          operation: "delegate_task",
          idempotency_key: "external-tool",
        },
      );
      expect(yield* restarted.latestNativeTurn(scope)).toEqual(latest);
      yield* restarted.submitTurn(scope, "command:turn-1", task);
      expect(yield* restarted.latestNativeTurn(scope)).toEqual(latest);
      expect(
        yield* Effect.flip(restarted.latestNativeTurn({ ...scope, instanceId: "instance-b" })),
      ).toMatchObject({ reason: "native-request-conflict" });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
