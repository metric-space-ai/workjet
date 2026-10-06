// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  TurnId,
  type GreppySettings,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@workjet/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as AcpSchema from "effect-acp/schema";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import { makeGreppyAcpRuntime } from "../acp/GreppyAcpSupport.ts";
import {
  terminateProviderProcesses,
  trackedChildProcess,
  type ProviderAdapterShape,
  type ProviderThreadTurnSnapshot,
  type ProviderTrackedProcess,
} from "../Services/ProviderAdapter.ts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { plainHttpEndpoint } from "../greppy/GreppyProtocol.ts";

const PROVIDER = ProviderDriverKind.make("greppy");
const encodeImportedHistory = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
const Resume = Schema.Struct({ protocol: Schema.Literal("acp"), sessionId: Schema.String });
const decodeResume = Schema.decodeUnknownOption(Resume);
const decodeImportHistoryCapability = Schema.decodeUnknownOption(
  Schema.Struct({ version: Schema.Literal(1) }),
);
const decodeImportHistoryAcknowledgement = Schema.decodeUnknownEffect(
  Schema.Struct({
    acceptedMessageIds: Schema.Array(Schema.String),
  }),
);

const requestError = (method: string, detail: string) =>
  new ProviderAdapterRequestError({ provider: PROVIDER, method, detail });

interface SessionContext {
  session: ProviderSession;
  readonly acp: AcpSessionRuntime["Service"];
  readonly acpSessionId: string;
  readonly supportsImportHistory: boolean;
  importedHistoryKey: string | undefined;

  readonly scope: Scope.Closeable;
  readonly processes: ProviderTrackedProcess[];
  readonly pending: Map<ApprovalRequestId, Deferred.Deferred<ProviderApprovalDecision>>;
  turns: ProviderThreadTurnSnapshot[];
  turnId: TurnId | undefined;
  cancelled: boolean;
  stopped: boolean;
  managedPrompt: string | undefined;
}

export function greppyPermissionOption(
  request: AcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  if (decision === "cancel") return undefined;
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return (
    request.options.find((option) => option.kind === kind)?.optionId ??
    request.options.find(
      (option) => option.kind === (kind === "allow_always" ? "allow_once" : kind),
    )?.optionId
  );
}

export const makeGreppyAdapter = Effect.fn("makeGreppyAdapter")(function* (
  config: GreppySettings,
  options: {
    readonly instanceId: ProviderInstanceId;
    readonly resolveSessionEnvironment: (
      model?: string,
    ) => Effect.Effect<NodeJS.ProcessEnv, ProviderAdapterError>;
  },
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const lock = yield* Semaphore.make(1);
  const sessions = new Map<ThreadId, SessionContext>();
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const stamp = Effect.gen(function* () {
    return { eventId: EventId.make(NodeCrypto.randomUUID()), createdAt: yield* now };
  });
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, { ...event, providerInstanceId: options.instanceId }).pipe(
      Effect.asVoid,
    );
  const emit = Effect.fn("greppy.emit")(function* (
    threadId: ThreadId,
    event: Pick<ProviderRuntimeEvent, "type" | "payload"> & { readonly turnId?: TurnId },
  ) {
    yield* publish({
      ...event,
      ...(yield* stamp),
      provider: PROVIDER,
      threadId,
    } as ProviderRuntimeEvent);
  });
  const requireSession = (threadId: ThreadId) => {
    const ctx = sessions.get(threadId);
    return ctx && !ctx.stopped
      ? Effect.succeed(ctx)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };
  const cancelPending = (ctx: SessionContext) =>
    Effect.forEach(ctx.pending.values(), (deferred) => Deferred.succeed(deferred, "cancel"), {
      discard: true,
    });
  const finish = Effect.fn("greppy.finish")(function* (
    ctx: SessionContext,
    turnId: TurnId,
    stopReason: string,
    errorMessage?: string,
  ) {
    if (ctx.turnId !== turnId || ctx.stopped) return;
    ctx.turnId = undefined;
    const { activeTurnId: _active, ...rest } = ctx.session;
    ctx.session = { ...rest, status: "ready", updatedAt: yield* now };
    yield* emit(ctx.session.threadId, {
      type: "turn.completed",
      turnId,
      payload: {
        state: errorMessage ? "failed" : stopReason === "cancelled" ? "cancelled" : "completed",
        stopReason,
        ...(errorMessage ? { errorMessage } : {}),
      },
    });
    yield* emit(ctx.session.threadId, {
      type: "session.state.changed",
      payload: { state: "ready" },
    });
  });
  const stop = Effect.fn("greppy.stop")(function* (ctx: SessionContext) {
    ctx.cancelled = true;
    yield* cancelPending(ctx);
    if (ctx.turnId) yield* finish(ctx, ctx.turnId, "cancelled");
    ctx.stopped = true;
    sessions.delete(ctx.session.threadId);
    const result = yield* terminateProviderProcesses({
      processes: ctx.processes,
      cooperative: ctx.acp.cancel.pipe(
        Effect.ignore,
        Effect.andThen(Scope.close(ctx.scope, Exit.void)),
      ),
    });
    yield* emit(ctx.session.threadId, {
      type: "session.exited",
      payload: { reason: "Greppy ACP process stopped" },
    });
    return result;
  });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (!config.enabled) return yield* requestError("startSession", "Greppy is disabled.");
        if (input.provider !== undefined && input.provider !== PROVIDER)
          return yield* requestError("startSession", "Expected the Greppy provider.");
        if (!input.cwd?.trim())
          return yield* requestError("startSession", "A project folder is required.");
        const managed = readMcpProviderSession(input.threadId);
        if (managed?.activeWorkjetMcpCapabilityIds.length) {
          return yield* requestError(
            "startSession",
            "Greppy ACP does not yet support Workjet MCP capabilities. Remove those capabilities or choose a harness that supports them.",
          );
        }
        const selection =
          input.modelSelection?.instanceId === options.instanceId
            ? input.modelSelection
            : undefined;
        const model = selection?.model.trim() || config.model.trim();
        if (!model)
          return yield* requestError("startSession", "Choose a model for the Greppy gateway.");
        const previous = sessions.get(input.threadId);
        if (previous) yield* stop(previous);
        const environment = yield* options.resolveSessionEnvironment(model);
        if (plainHttpEndpoint(environment.GREPPY_ENDPOINT || config.endpoint) === null) {
          return yield* requestError(
            "startSession",
            "Greppy requires a plain HTTP gateway root without credentials in its URL.",
          );
        }
        const scope = yield* Scope.make("sequential");
        const processes: ProviderTrackedProcess[] = [];
        const pending = new Map<ApprovalRequestId, Deferred.Deferred<ProviderApprovalDecision>>();
        let transferred = false;
        const resume = decodeResume(input.resumeCursor);
        const resumeSessionId = resume._tag === "Some" ? resume.value.sessionId : undefined;
        if (input.resumeCursor !== undefined && !resumeSessionId) {
          yield* Scope.close(scope, Exit.void);
          return yield* requestError(
            "startSession",
            "This Greppy session uses an older transport and cannot be resumed through ACP.",
          );
        }
        const acp = yield* makeGreppyAcpRuntime({
          config,
          environment,
          model,
          spawner,
          cwd: input.cwd,
          clientInfo: { name: "workjet", version: "1" },
          clientCapabilities: {},
          ...(resumeSessionId ? { resumeSessionId } : {}),
          onProcessSpawn: (handle) => processes.push(trackedChildProcess(handle)),
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
          ),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        return yield* Effect.gen(function* () {
          yield* acp.handleRequestPermission((params) =>
            Effect.gen(function* () {
              const ctx = sessions.get(input.threadId);
              if (!ctx || ctx.stopped || ctx.cancelled)
                return { outcome: { outcome: "cancelled" as const } };
              if (input.runtimeMode === "full-access") {
                const optionId = greppyPermissionOption(params, "accept");
                return {
                  outcome: optionId
                    ? { outcome: "selected" as const, optionId }
                    : { outcome: "cancelled" as const },
                };
              }
              const requestId = ApprovalRequestId.make(NodeCrypto.randomUUID());
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              pending.set(requestId, decision);
              const parsed = parsePermissionRequest(params);
              const turnId = ctx.turnId;
              yield* publish(
                makeAcpRequestOpenedEvent({
                  stamp: yield* stamp,
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: RuntimeRequestId.make(requestId),
                  permissionRequest: parsed,
                  detail: parsed.detail ?? "Greppy requests tool permission",
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );
              const resolved = yield* Deferred.await(decision).pipe(
                Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
              );
              yield* publish(
                makeAcpRequestResolvedEvent({
                  stamp: yield* stamp,
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: RuntimeRequestId.make(requestId),
                  permissionRequest: parsed,
                  decision: resolved,
                }),
              );
              const optionId = ctx.cancelled ? undefined : greppyPermissionOption(params, resolved);
              return {
                outcome: optionId
                  ? { outcome: "selected" as const, optionId }
                  : { outcome: "cancelled" as const },
              };
            }),
          );
          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
              ),
            );
          yield* acp
            .setSessionModel(model)
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              ),
            );
          const createdAt = yield* now;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            cwd: input.cwd,
            runtimeMode: input.runtimeMode,
            model,
            status: "ready",
            resumeCursor: { protocol: "acp", sessionId: started.sessionId },
            createdAt,
            updatedAt: createdAt,
          };
          const ctx: SessionContext = {
            session,
            acp,
            acpSessionId: started.sessionId,
            supportsImportHistory:
              decodeImportHistoryCapability(
                started.initializeResult.agentCapabilities?._meta?.workjetImportHistory,
              )._tag === "Some",
            importedHistoryKey: undefined,
            scope,

            processes,
            pending,
            turns: [],
            turnId: undefined,
            cancelled: false,
            stopped: false,
            managedPrompt:
              managed?.compiledManagedPrompt.trim() ||
              input.workjetConfig?.managedInstructions.trim(),
          };
          yield* acp.getEvents().pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (ctx.stopped) return;
                const common = {
                  stamp: yield* stamp,
                  provider: PROVIDER,
                  threadId: ctx.session.threadId,
                  turnId: ctx.turnId,
                };
                switch (event._tag) {
                  case "ContentDelta":
                    yield* publish(
                      makeAcpContentDeltaEvent({
                        ...common,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    break;
                  case "AssistantItemStarted":
                  case "AssistantItemCompleted":
                    yield* publish(
                      makeAcpAssistantItemEvent({
                        ...common,
                        itemId: event.itemId,
                        lifecycle:
                          event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                      }),
                    );
                    break;
                  case "ToolCallUpdated":
                    yield* publish(
                      makeAcpToolCallEvent({
                        ...common,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    break;
                  case "PlanUpdated":
                    yield* publish(
                      makeAcpPlanUpdatedEvent({
                        ...common,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    break;
                  case "ModeChanged":
                    break;
                }
              }),
            ),
            Effect.forkIn(scope),
          );
          sessions.set(input.threadId, ctx);
          transferred = true;
          yield* emit(input.threadId, {
            type: "session.started",
            payload: { resume: started.initializeResult },
          });
          yield* emit(input.threadId, {
            type: "session.state.changed",
            payload: { state: "ready", reason: "Greppy ACP session ready" },
          });
          yield* emit(input.threadId, {
            type: "thread.started",
            payload: { providerThreadId: started.sessionId },
          });
          return session;
        }).pipe(
          Effect.ensuring(
            transferred
              ? Effect.void
              : Effect.suspend(() => (transferred ? Effect.void : Scope.close(scope, Exit.void))),
          ),
        );
      }),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const prepared = yield* lock.withPermit(
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          if (ctx.turnId)
            return yield* requestError(
              "sendTurn",
              "Greppy is already answering. Stop the current turn before sending another prompt.",
            );
          if (input.attachments?.length)
            return yield* requestError("sendTurn", "Greppy ACP currently accepts text only.");
          if (input.interactionMode === "plan")
            return yield* requestError(
              "sendTurn",
              "Greppy ACP does not support a separate planning mode.",
            );
          if (!input.input?.trim())
            return yield* requestError("sendTurn", "A text prompt is required.");
          const turnId = TurnId.make(NodeCrypto.randomUUID());
          ctx.turnId = turnId;
          ctx.cancelled = false;
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* now,
          };
          return { ctx, turnId, text: input.input };
        }),
      );
      const { ctx, turnId } = prepared;
      return yield* Effect.gen(function* () {
        const selected =
          input.modelSelection?.instanceId === options.instanceId
            ? input.modelSelection.model.trim()
            : undefined;
        if (selected && selected !== ctx.session.model) {
          yield* ctx.acp
            .setSessionModel(selected)
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              ),
            );
          ctx.session = { ...ctx.session, model: selected };
        }
        if (input.importedHistory?.length && !ctx.cancelled && !ctx.stopped) {
          if (!ctx.supportsImportHistory)
            return yield* requestError(
              "_workjet/import_history",
              "This Greppy build cannot replay imported conversations. Update Greppy to a build with Workjet history synchronization.",
            );
          const historyJson = yield* encodeImportedHistory(input.importedHistory).pipe(
            Effect.mapError(() =>
              requestError(
                "_workjet/import_history",
                "Imported conversation history could not be encoded.",
              ),
            ),
          );
          const historyKey = NodeCrypto.createHash("sha256")
            .update(historyJson)
            .digest("hex");
          if (historyKey !== ctx.importedHistoryKey) {
            const response = yield* ctx.acp
              .request("_workjet/import_history", {
                sessionId: ctx.acpSessionId,
                messages: input.importedHistory,
              })
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "_workjet/import_history", cause),
                ),
              );
            const acknowledgement = yield* decodeImportHistoryAcknowledgement(response).pipe(
              Effect.mapError(() =>
                requestError(
                  "_workjet/import_history",
                  "Greppy did not acknowledge the imported conversation history.",
                ),
              ),
            );
            if (
              acknowledgement.acceptedMessageIds.length !== input.importedHistory.length ||
              !input.importedHistory.every(
                (message, index) => acknowledgement.acceptedMessageIds[index] === message.id,
              )
            )
              return yield* requestError(
                "_workjet/import_history",
                "Greppy acknowledged an incomplete or different imported conversation.",
              );
            ctx.importedHistoryKey = historyKey;
          }
        }
        if (ctx.cancelled || ctx.stopped) {
          yield* finish(ctx, turnId, "cancelled");
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }
        yield* emit(input.threadId, {
          type: "turn.started",

          turnId,
          payload: { model: ctx.session.model },
        });
        const text = ctx.managedPrompt
          ? `<workjet_managed_instructions>\n${ctx.managedPrompt}\n</workjet_managed_instructions>\n\n${prepared.text}`
          : prepared.text;
        const prompt = [{ type: "text" as const, text }];
        const result = yield* ctx.acp
          .prompt({ prompt })
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause),
            ),
          );
        yield* ctx.acp.drainEvents;
        ctx.managedPrompt = undefined;
        ctx.turns = [...ctx.turns, { id: turnId, items: [{ prompt, result }] }];
        yield* finish(ctx, turnId, ctx.cancelled ? "cancelled" : result.stopReason);
        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      }).pipe(
        Effect.tapError((error) => finish(ctx, turnId, "error", error.message)),
        Effect.ensuring(
          Effect.suspend(() =>
            ctx.turnId === turnId ? finish(ctx, turnId, "cancelled") : Effect.void,
          ),
        ),
      );
    });
  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    threadId,
    turnId,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      if (!ctx.turnId || (turnId && ctx.turnId !== turnId)) return;
      ctx.cancelled = true;
      yield* cancelPending(ctx);
      yield* ctx.acp.cancel.pipe(
        Effect.mapError((cause) =>
          mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause),
        ),
      );
    });
  const adapter = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" as const },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pending.get(requestId);
        if (!pending)
          return yield* requestError(
            "respondToRequest",
            "This Greppy permission request is no longer pending.",
          );
        yield* Deferred.succeed(pending, decision);
      }),
    respondToUserInput: () =>
      Effect.fail(
        requestError("respondToUserInput", "Greppy ACP does not request structured user input."),
      ),
    stopSession: (threadId) =>
      lock.withPermit(
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          return yield* stop(ctx);
        }),
      ),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: ctx.turns })),
    rollbackThread: () =>
      Effect.fail(
        requestError("rollbackThread", "Greppy ACP does not support transcript rollback."),
      ),
    stopAll: () => Effect.forEach([...sessions.values()], stop, { discard: true }),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
  yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
  return adapter;
});
