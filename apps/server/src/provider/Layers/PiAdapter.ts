// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@workjet/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  terminateProviderProcesses,
  trackedChildProcess,
  type ProviderAdapterShape,
  type ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import { makePiRpc, type PiRpc } from "../pi/PiRpc.ts";
import type { PiRpcMessage } from "../pi/PiRpcProtocol.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const error = (method: string, detail: string) =>
  new ProviderAdapterRequestError({ provider: PROVIDER, method, detail });
const Resume = Schema.Struct({ protocol: Schema.Literal("pi-rpc"), sessionFile: Schema.String });
const decodeResume = Schema.decodeUnknownOption(Resume);
const decodeState = Schema.decodeUnknownEffect(
  Schema.Struct({
    sessionId: Schema.String,
    sessionFile: Schema.optional(Schema.NullOr(Schema.String)),
    model: Schema.NullOr(Schema.Struct({ id: Schema.String, provider: Schema.String })),
  }),
);
const decodeAssistant = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.String,
    stopReason: Schema.optional(Schema.String),
    errorMessage: Schema.optional(Schema.String),
  }),
);
const decodeMessages = Schema.decodeUnknownEffect(
  Schema.Struct({ messages: Schema.Array(Schema.Unknown) }),
);

interface SessionContext {
  session: ProviderSession;
  readonly rpc: PiRpc;
  readonly scope: Scope.Closeable;
  readonly turns: ProviderThreadTurnSnapshot[];
  turnId: TurnId | undefined;
  finished: Deferred.Deferred<void> | undefined;
  cancelled: boolean;
  stopped: boolean;
  exited: boolean;
  assistantIndex: number;
  turnError: string | undefined;
  importedHistoryKey: string | undefined;
  managedPrompt: string | undefined;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly enabled: boolean;
  readonly sessionDirectory: string;
  readonly extensionPath?: string;
  readonly resolveModel: (
    model: string,
  ) => Effect.Effect<
    { provider: string; model: string; environment: NodeJS.ProcessEnv },
    ProviderAdapterRequestError
  >;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const lock = yield* Semaphore.make(1);
  const sessions = new Map<ThreadId, SessionContext>();
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  type Event = ProviderRuntimeEvent extends infer E
    ? E extends ProviderRuntimeEvent
      ? Omit<E, "eventId" | "createdAt" | "provider" | "providerInstanceId" | "threadId">
      : never
    : never;
  const emit = Effect.fn("Pi.emit")(function* (threadId: ThreadId, event: Event) {
    yield* PubSub.publish(events, {
      ...event,
      provider: PROVIDER,
      providerInstanceId: input.instanceId,
      threadId,
      eventId: EventId.make(randomUUID()),
      createdAt: yield* now,
    } as ProviderRuntimeEvent);
  });
  const requireSession = (threadId: ThreadId) => {
    const ctx = sessions.get(threadId);
    return ctx && !ctx.stopped && !ctx.exited
      ? Effect.succeed(ctx)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };
  const finish = Effect.fn("Pi.finish")(function* (ctx: SessionContext) {
    const turnId = ctx.turnId;
    if (!turnId) return;
    const finished = ctx.finished;
    ctx.turnId = undefined;
    ctx.finished = undefined;
    const { activeTurnId: _active, ...rest } = ctx.session;
    ctx.session = { ...rest, status: ctx.exited ? "error" : "ready", updatedAt: yield* now };
    yield* emit(ctx.session.threadId, {
      type: "turn.completed",
      turnId,
      payload: {
        state: ctx.turnError ? "failed" : ctx.cancelled ? "cancelled" : "completed",
        ...(ctx.turnError ? { errorMessage: ctx.turnError } : {}),
      },
    });
    yield* emit(ctx.session.threadId, {
      type: "session.state.changed",
      payload: { state: ctx.exited ? "error" : "ready" },
    });
    if (finished) yield* Deferred.succeed(finished, undefined);
  });
  const observe = Effect.fn("Pi.observe")(function* (ctx: SessionContext, event: PiRpcMessage) {
    if (ctx.stopped) return;
    if (event.type === "workjet_process_exited") {
      ctx.exited = true;
      ctx.turnError = "The Pi RPC process exited before the session was stopped.";
      yield* finish(ctx);
      yield* emit(ctx.session.threadId, {
        type: "session.exited",
        payload: { reason: ctx.turnError },
      });
      return;
    }
    const turnId = ctx.turnId;
    if (!turnId) return;
    if (event.type === "message_start") ctx.assistantIndex++;
    if (event.type === "message_update" && event.assistantMessageEvent?.delta !== undefined) {
      const delta = event.assistantMessageEvent;
      if (delta.type === "text_delta" || delta.type === "thinking_delta")
        yield* emit(ctx.session.threadId, {
          type: "content.delta",
          turnId,
          itemId: RuntimeItemId.make(`${turnId}-message-${ctx.assistantIndex}`),
          payload: {
            streamKind: delta.type === "text_delta" ? "assistant_text" : "reasoning_text",
            delta: delta.delta!,
          },
        });
    }
    if (
      (event.type === "tool_execution_start" || event.type === "tool_execution_end") &&
      event.toolCallId &&
      event.toolName
    ) {
      yield* emit(ctx.session.threadId, {
        type: event.type === "tool_execution_start" ? "item.started" : "item.completed",
        turnId,
        itemId: RuntimeItemId.make(event.toolCallId),
        payload: {
          itemType:
            event.toolName === "bash"
              ? "command_execution"
              : ["write", "edit"].includes(event.toolName)
                ? "file_change"
                : "dynamic_tool_call",
          status:
            event.type === "tool_execution_start"
              ? "inProgress"
              : event.isError
                ? "failed"
                : "completed",
          title: event.toolName,
          data: {
            toolName: event.toolName,
            args: event.args,
            result: event.result,
            isError: event.isError ?? false,
          },
        },
      });
    }
    if (event.type === "agent_end") {
      for (const message of event.messages ?? []) {
        const assistant = decodeAssistant(message);
        if (
          Option.isSome(assistant) &&
          assistant.value.role === "assistant" &&
          assistant.value.stopReason === "error"
        )
          ctx.turnError = assistant.value.errorMessage ?? "Pi inference failed.";
      }
      yield* finish(ctx);
    }
  });
  const stop = Effect.fn("Pi.stop")(function* (ctx: SessionContext) {
    ctx.cancelled = true;
    yield* finish(ctx);
    ctx.stopped = true;
    sessions.delete(ctx.session.threadId);
    const result = yield* terminateProviderProcesses({
      processes: [trackedChildProcess(ctx.rpc.child)],
      cooperative: (ctx.exited ? Effect.void : ctx.rpc.request("abort").pipe(Effect.ignore)).pipe(
        Effect.andThen(Scope.close(ctx.scope, Exit.void)),
      ),
    });
    yield* emit(ctx.session.threadId, {
      type: "session.exited",
      payload: { reason: "Pi RPC session stopped" },
    });
    return result;
  });
  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (inputStart) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (!input.enabled) return yield* error("startSession", "Pi Code is disabled.");
        if (inputStart.runtimeMode !== "full-access")
          return yield* error(
            "startSession",
            "Pi Code's native tools require full-access mode; this RPC transport cannot enforce approval or sandbox policies.",
          );
        if (!inputStart.cwd?.trim())
          return yield* error("startSession", "A project folder is required.");
        if (inputStart.modelSelection?.instanceId !== input.instanceId)
          return yield* error(
            "startSession",
            "Choose a connected gateway model for this Pi instance.",
          );
        const managed = readMcpProviderSession(inputStart.threadId);
        if (managed?.activeWorkjetMcpCapabilityIds.length && !input.extensionPath)
          return yield* error("startSession", "The Pi Workjet MCP extension is unavailable.");
        const model = inputStart.modelSelection.model;
        const selected = yield* input.resolveModel(model);
        const decoded = decodeResume(inputStart.resumeCursor);
        if (inputStart.resumeCursor !== undefined && Option.isNone(decoded))
          return yield* error("startSession", "This is not a resumable Pi RPC session.");
        const resume = Option.isSome(decoded) ? decoded.value.sessionFile : undefined;
        if (resume) {
          const relative = path.relative(input.sessionDirectory, resume);
          if (
            path.isAbsolute(relative) ||
            relative.startsWith("..") ||
            !(yield* fs
              .exists(resume)
              .pipe(
                Effect.mapError(() =>
                  error("startSession", "The saved Pi session could not be checked."),
                ),
              ))
          )
            return yield* error(
              "startSession",
              "The saved Pi session is unavailable in this instance's private directory.",
            );
        } else if (inputStart.resumePolicy === "require-existing")
          return yield* error(
            "startSession",
            "This Pi session has no existing native conversation to resume.",
          );
        const previous = sessions.get(inputStart.threadId);
        if (previous) yield* stop(previous);
        const scope = yield* Scope.make();
        return yield* Effect.gen(function* () {
          const rpc = yield* makePiRpc({
            binaryPath: input.binaryPath,
            cwd: inputStart.cwd!,
            environment: {
              ...selected.environment,
              ...(managed
                ? {
                    WORKJET_PI_MCP_ENDPOINT: managed.endpoint,
                    WORKJET_PI_MCP_AUTHORIZATION: managed.authorizationHeader,
                  }
                : {}),
            },
            args: [
              "--mode",
              "rpc",
              "--provider",
              selected.provider,
              "--model",
              selected.model,
              "--session-dir",
              input.sessionDirectory,
              ...(input.extensionPath ? ["--extension", input.extensionPath] : []),
              ...(resume ? ["--session", resume] : []),
            ],
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          const state = yield* rpc.request("get_state").pipe(
            Effect.flatMap(decodeState),
            Effect.mapError((cause) => error("get_state", cause.message)),
          );
          if (state.model?.id !== selected.model || state.model.provider !== selected.provider)
            return yield* error("startSession", "Pi did not activate the selected gateway model.");
          const createdAt = yield* now;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: input.instanceId,
            threadId: inputStart.threadId,
            runtimeMode: inputStart.runtimeMode,
            cwd: inputStart.cwd!,
            model,
            status: "ready",
            createdAt,
            updatedAt: createdAt,
            ...(state.sessionFile
              ? { resumeCursor: { protocol: "pi-rpc", sessionFile: state.sessionFile } }
              : {}),
          };
          const ctx: SessionContext = {
            session,
            rpc,
            scope,
            turns: [],
            turnId: undefined,
            finished: undefined,
            cancelled: false,
            stopped: false,
            exited: false,
            assistantIndex: 0,
            turnError: undefined,
            importedHistoryKey: undefined,
            managedPrompt:
              managed?.compiledManagedPrompt || inputStart.workjetConfig?.managedInstructions,
          };
          sessions.set(inputStart.threadId, ctx);
          yield* rpc.events.pipe(
            Stream.runForEach((event) => observe(ctx, event)),
            Effect.forkIn(scope),
          );
          yield* emit(inputStart.threadId, {
            type: "session.started",
            payload: { resume: session.resumeCursor },
          });
          yield* emit(inputStart.threadId, {
            type: "session.state.changed",
            payload: { state: "ready" },
          });
          return session;
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      }),
    );
  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn("Pi.sendTurn")(
    function* (turn) {
      const ctx = yield* requireSession(turn.threadId);
      if (ctx.turnId) return yield* error("sendTurn", "The Pi session already has an active turn.");
      if (turn.interactionMode === "plan")
        return yield* error("sendTurn", "Pi RPC does not provide a separate planning mode.");
      if (turn.attachments?.length)
        return yield* error("sendTurn", "Pi RPC attachments are not supported by this transport.");
      if (!turn.input?.trim()) return yield* error("sendTurn", "A text prompt is required.");
      const model = turn.modelSelection?.model ?? ctx.session.model;
      if (!model || (turn.modelSelection && turn.modelSelection.instanceId !== input.instanceId))
        return yield* error("sendTurn", "Choose a gateway model for this Pi instance.");
      if (model !== ctx.session.model) {
        const selected = yield* input.resolveModel(model);
        yield* ctx.rpc.request("set_model", {
          provider: selected.provider,
          modelId: selected.model,
        });
      }
      const turnId = TurnId.make(randomUUID());
      const finished = yield* Deferred.make<void>();
      ctx.turnId = turnId;
      ctx.finished = finished;
      ctx.cancelled = false;
      ctx.turnError = undefined;
      ctx.session = {
        ...ctx.session,
        model,
        status: "running",
        activeTurnId: turnId,
        updatedAt: yield* now,
      };
      yield* emit(turn.threadId, { type: "turn.started", turnId, payload: { model } });
      const historyKey = turn.importedHistory?.map((message) => message.id).join("|");
      const history =
        historyKey && historyKey !== ctx.importedHistoryKey
          ? `<imported_conversation>\n${turn.importedHistory!.map((message) => `${message.role}:\n${message.text}`).join("\n\n")}\n</imported_conversation>\n\n`
          : "";
      const managed = ctx.managedPrompt
        ? `<workjet_managed_instructions>\n${ctx.managedPrompt}\n</workjet_managed_instructions>\n\n`
        : "";
      yield* ctx.rpc.request("prompt", { message: managed + history + turn.input }).pipe(
        Effect.tapError((cause) => {
          ctx.turnError = cause.message;
          return finish(ctx);
        }),
      );
      ctx.managedPrompt = undefined;
      ctx.importedHistoryKey = historyKey;
      // Native RPC acknowledges dispatch before agent_end; return that receipt now.
      const state = yield* ctx.rpc.request("get_state").pipe(
        Effect.flatMap(decodeState),
        Effect.mapError((cause) => error("get_state", cause.message)),
      );
      if (state.sessionFile)
        ctx.session = {
          ...ctx.session,
          resumeCursor: { protocol: "pi-rpc", sessionFile: state.sessionFile },
        };
      ctx.turns.push({ id: turnId, items: [{ prompt: turn.input }] });
      return {
        threadId: turn.threadId,
        turnId,
        ...(ctx.session.resumeCursor ? { resumeCursor: ctx.session.resumeCursor } : {}),
      };
    },
  );
  const adapter = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" as const },
    startSession,
    sendTurn,
    interruptTurn: (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!ctx.turnId || (turnId && ctx.turnId !== turnId)) return;
        ctx.cancelled = true;
        yield* ctx.rpc.request("abort");
      }),
    respondToRequest: () =>
      Effect.fail(error("respondToRequest", "Pi RPC does not expose tool approvals.")),
    respondToUserInput: () =>
      Effect.fail(error("respondToUserInput", "Pi RPC does not expose structured user input.")),
    stopSession: (threadId) =>
      lock.withPermit(
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx)
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          return yield* stop(ctx);
        }),
      ),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session)),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.exited),
    readThread: (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const result = yield* ctx.rpc.request("get_messages").pipe(
          Effect.flatMap(decodeMessages),
          Effect.mapError((cause) => error("get_messages", cause.message)),
        );
        return {
          threadId,
          turns: [{ id: TurnId.make(`pi-${threadId}`), items: [...result.messages] }],
        };
      }),
    rollbackThread: () =>
      Effect.fail(error("rollbackThread", "Pi RPC does not support Workjet turn-count rollback.")),
    stopAll: () => Effect.forEach([...sessions.values()], stop, { discard: true }),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
  yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
  return adapter;
});
