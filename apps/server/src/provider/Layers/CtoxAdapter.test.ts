import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  WorkjetConnectionId,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration60 from "../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import migration61 from "../../persistence/Migrations/061_WorkjetCtoxNativeTurns.ts";
import { CtoxNativeRequests } from "../../workjet/ctox/CtoxNativeRequests.ts";
import {
  CtoxMcpTransportError,
  type makeCtoxMcpTransport,
} from "../../workjet/ctox/CtoxMcpTransport.ts";
import { makeCtoxNativeTaskClient } from "../../workjet/ctox/CtoxNativeTaskClient.ts";
import { CTOX_NATIVE_MODEL, makeCtoxAdapter } from "./CtoxAdapter.ts";

const threadId = ThreadId.make("native-thread");
const instanceId = ProviderInstanceId.make("ctox-office");
const connectionId = WorkjetConnectionId.make("office");
const scope = { threadId, connectionId, instanceId: "instance-office" };
const target = { endpoint: "https://mcp.ctox.dev/mcp/instance-office", token: "test-token" };
const TaskArgs = Schema.Struct({ idempotency_key: Schema.String, module_id: Schema.String });
const decodeArgs = Schema.decodeUnknownEffect(TaskArgs);
const startInput = {
  threadId,
  providerInstanceId: instanceId,
  runtimeMode: "approval-required" as const,
  modelSelection: { instanceId, model: CTOX_NATIVE_MODEL },
};
const turnInput = { threadId, requestId: "command:turn-1", input: "Review inventory" };

const fixture = (loseFirstWrite = false) =>
  Effect.gen(function* () {
    yield* migration60;
    yield* migration61;
    // `duringWrite` runs inside the native submission, i.e. while `sendTurn` is
    // holding its session entry and waiting on the network. That is the only
    // moment the close-during-submit race exists.
    const state = {
      status: "running",
      writes: 0,
      loseFirstWrite,
      duringWrite: undefined as Effect.Effect<void> | undefined,
    };
    const tasks = new Map<
      string,
      { module_id: string; command_type: string; command_id: string; task_id: string }
    >();
    const transport: ReturnType<typeof makeCtoxMcpTransport> = {
      probe: () => Effect.succeed(undefined),
      callTool: (_, name, args) =>
        Effect.gen(function* () {
          if (name === "business_os.execute_action") {
            state.writes += 1;
            if (state.duringWrite) {
              const during = state.duringWrite;
              state.duringWrite = undefined;
              yield* during;
            }
            const data = yield* decodeArgs(args).pipe(Effect.orDie);
            let task = tasks.get(data.idempotency_key);
            if (!task) {
              task = {
                module_id: data.module_id,
                command_type: "ctox.delegate_task",
                command_id: `cmd-${tasks.size}`,
                task_id: `task-${tasks.size}`,
              };
              tasks.set(data.idempotency_key, task);
            }
            if (state.loseFirstWrite) {
              state.loseFirstWrite = false;
              return yield* new CtoxMcpTransportError({ reason: "connection-unavailable" });
            }
            return { structuredContent: task };
          }
          expect(name).toBe("business_os.get_command_status");
          const task = [...tasks.values()].find((task) => task.command_id === args.command_id);
          if (!task) return yield* new CtoxMcpTransportError({ reason: "remote-response-invalid" });
          return {
            structuredContent: {
              ok: true,
              record: {
                id: task.command_id,
                collection: "business_commands",
                status: state.status,
                data: {
                  command_id: task.command_id,
                  task_id: task.task_id,
                  module: task.module_id,
                  status: state.status,
                  ...(state.status === "completed" ? { result: "Native review completed" } : {}),
                },
              },
            },
          };
        }),
    };
    const open = Effect.gen(function* () {
      const requests = yield* CtoxNativeRequests.pipe(Effect.provide(CtoxNativeRequests.layer));
      const client = makeCtoxNativeTaskClient({
        requests,
        transport,
        connections: { resolveReadyTarget: () => Effect.succeed(target) },
      });
      const adapter = yield* makeCtoxAdapter({
        instanceId,
        ctoxInstanceId: scope.instanceId,
        connectionId,
        client,
        resolveTaskScope: () => Effect.succeed({ module_id: "inventory" }),
      });
      return { adapter, client };
    });
    return { state, tasks, open };
  });

it.effect("reopens the same native task and closing Dev only stops observation", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const first = yield* test.open;
    yield* first.adapter.startSession(startInput);
    const started = yield* first.adapter.sendTurn(turnInput);
    yield* TestClock.adjust("2 seconds");
    yield* first.adapter.stopSession(threadId);
    expect(test.state.writes).toBe(1);
    expect(test.tasks.size).toBe(1);
    expect(test.state.status).toBe("running");
    expect(yield* first.adapter.hasSession(threadId)).toBe(false);

    const second = yield* test.open;
    const events: ProviderRuntimeEvent[] = [];
    yield* Stream.runForEach(second.adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* second.adapter.startSession({ ...startInput, resumeCursor: started.resumeCursor });
    yield* TestClock.adjust("2 seconds");
    expect(test.state.writes).toBe(1);
    expect((yield* second.adapter.listSessions())[0]?.activeTurnId).toBe(started.turnId);
    expect(
      yield* Effect.flip(second.adapter.sendTurn({ ...turnInput, requestId: "command:turn-2" })),
    ).toMatchObject({ _tag: "ProviderAdapterRequestError" });
    expect(test.state.writes).toBe(1);
    test.state.status = "completed";
    yield* TestClock.adjust("2 seconds");
    expect(
      events.some(
        (event) =>
          event.type === "turn.completed" &&
          event.turnId === started.turnId &&
          event.payload.state === "completed",
      ),
    ).toBe(true);
    expect(events.every(Schema.is(ProviderRuntimeEvent))).toBe(true);
    expect((yield* second.adapter.listSessions())[0]?.status).toBe("ready");
    yield* second.adapter.stopAll();
    expect(test.state.writes).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("recovers the accepted task after a lost response without creating a second task", () =>
  Effect.gen(function* () {
    const test = yield* fixture(true);
    const first = yield* test.open;
    yield* first.adapter.startSession(startInput);
    expect(yield* Effect.flip(first.adapter.sendTurn(turnInput))).toMatchObject({
      _tag: "ProviderAdapterRequestError",
    });
    expect(test.tasks.size).toBe(1);
    const pending = yield* first.client.latestNativeTurn(scope);
    expect(pending).toMatchObject({
      requestId: turnInput.requestId,
      reference: { commandId: null },
    });
    yield* first.adapter.stopAll();
    const second = yield* test.open;
    yield* second.adapter.startSession(startInput);
    expect(test.state.writes).toBe(2);
    expect(test.tasks.size).toBe(1);
    expect(yield* second.client.latestNativeTurn(scope)).toMatchObject({
      reference: { commandId: "cmd-0", taskId: "task-0" },
    });
    yield* second.adapter.stopAll();
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "refuses retargeted cursors and unsupported controls without affecting native execution",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const { adapter } = yield* test.open;
      const session = yield* adapter.startSession(startInput);
      expect(
        yield* Effect.flip(
          adapter.startSession({
            ...startInput,
            resumeCursor: {
              kind: "ctox-native",
              version: 1,
              instanceId: "other",
              connectionId,
              moduleId: "inventory",
              recordId: null,
            },
          }),
        ),
      ).toMatchObject({ _tag: "ProviderAdapterRequestError" });
      expect(
        yield* Effect.flip(adapter.sendTurn({ threadId, input: "Missing identity" })),
      ).toMatchObject({ _tag: "ProviderAdapterRequestError" });
      expect(test.state.writes).toBe(0);
      yield* adapter.sendTurn(turnInput);
      expect(yield* Effect.flip(adapter.interruptTurn(threadId))).toMatchObject({
        _tag: "ProviderAdapterRequestError",
      });
      expect(test.state.writes).toBe(1);
      expect(test.state.status).toBe("running");
      expect(session.resumeCursor).toMatchObject({
        instanceId: scope.instanceId,
        moduleId: "inventory",
      });
      yield* adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);

/**
 * CLOSING DEV WHILE A SUBMISSION IS STILL IN FLIGHT.
 *
 * `sendTurn` resolves its session entry up front and then waits on the network.
 * `stopSession` meanwhile removes that entry, interrupts its observer and emits
 * `session.exited`. When the submission then returns, `sendTurn` still holds the
 * entry it captured — and arming an observer on it emits `turn.started` and
 * `item.started` for a session Dev has already been told is closed, forking a
 * fiber into the owner scope that nothing will ever stop.
 *
 * The native task is not the thing at risk here: it is accepted, it keeps
 * running, and Ops must still show it. Only the observation is dropped.
 */
it.effect("drops only observation when Dev closes during a native submission", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const first = yield* test.open;
    const events: ProviderRuntimeEvent[] = [];
    yield* Stream.runForEach(first.adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* first.adapter.startSession(startInput);
    // Dev closes exactly while the submission is on the wire.
    test.state.duringWrite = first.adapter.stopSession(threadId).pipe(Effect.orDie);
    yield* first.adapter.sendTurn(turnInput).pipe(Effect.result);
    yield* TestClock.adjust("2 seconds");

    // The session is gone and stays gone: no observer re-armed it.
    expect(yield* first.adapter.hasSession(threadId)).toBe(false);
    expect(yield* first.adapter.listSessions()).toEqual([]);
    const exited = events.findIndex((event) => event.type === "session.exited");
    expect(exited).toBeGreaterThanOrEqual(0);
    expect(events.slice(exited + 1).map(({ type }) => type)).toEqual([]);

    // The native task was accepted exactly once and is untouched by the close.
    expect(test.state.writes).toBe(1);
    expect(test.tasks.size).toBe(1);
    expect(test.state.status).toBe("running");

    // Reopening Dev finds that same task rather than starting a second one.
    const second = yield* test.open;
    yield* second.adapter.startSession(startInput);
    yield* TestClock.adjust("2 seconds");
    expect(test.state.writes).toBe(1);
    expect(test.tasks.size).toBe(1);
    expect(yield* second.client.latestNativeTurn(scope)).toMatchObject({
      requestId: turnInput.requestId,
      reference: { commandId: "cmd-0", taskId: "task-0" },
    });
    yield* second.adapter.stopAll();
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);
