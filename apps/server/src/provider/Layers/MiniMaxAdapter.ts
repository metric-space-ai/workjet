import { admitWorkerSourceNativeProfile } from "../../workjet/WorkerSourceNativeAdmission.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  TurnId,
  type MiniMaxSettings,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderOptionSelections,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
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
import { AcpRequestError } from "effect-acp/errors";
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
import type { AcpSessionRuntime, AcpSessionRuntimeOptions } from "../acp/AcpSessionRuntime.ts";
import { makeMiniMaxAcpRuntime } from "../acp/MiniMaxAcpSupport.ts";
import {
  miniMaxRequestedEffort,
  miniMaxEffortValue,
  resolveMiniMaxModelValue,
  MINIMAX_CODE_RELEASE,
  assertMiniMaxApprovalMode,
} from "../minimax/MiniMaxProtocol.ts";
import {
  miniMaxElicitationForm,
  MiniMaxElicitationRequest,
} from "../minimax/MiniMaxElicitation.ts";
import {
  terminateProviderProcesses,
  trackedChildProcess,
  type ProviderAdapterShape,
  type ProviderThreadTurnSnapshot,
  type ProviderTrackedProcess,
} from "../Services/ProviderAdapter.ts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";

const PROVIDER = ProviderDriverKind.make("minimax");
const Resume = Schema.Struct({
  protocol: Schema.Literal("minimax-acp"),
  sessionId: Schema.String.check(Schema.isPattern(/\S/)),
  profileKey: Schema.String,
});
const decodeResume = Schema.decodeUnknownOption(Resume);
const encodeProfileKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const error = (method: string, detail: string) =>
  new ProviderAdapterRequestError({ provider: PROVIDER, method, detail });
const checked = <A>(method: string, evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      error(method, cause instanceof Error ? cause.message : "Invalid MiniMax Code selection."),
  });
const withDeadline = <A>(method: string, operation: Effect.Effect<A, ProviderAdapterError>) =>
  operation.pipe(
    Effect.timeoutOption("30 seconds"),
    Effect.flatMap((result) =>
      result._tag === "Some"
        ? Effect.succeed(result.value)
        : Effect.fail(
            error(method, "MiniMax Code did not acknowledge the operation within 30 seconds."),
          ),
    ),
  );

interface PendingQuestion {
  readonly answer: Deferred.Deferred<ProviderUserInputAnswers>;
  readonly form: ReturnType<typeof miniMaxElicitationForm>;
}

interface SessionContext {
  session: ProviderSession;
  readonly acp: AcpSessionRuntime["Service"];
  readonly scope: Scope.Closeable;
  readonly processes: ProviderTrackedProcess[];
  readonly pending: Map<ApprovalRequestId, Deferred.Deferred<ProviderApprovalDecision>>;
  readonly inputs: Map<ApprovalRequestId, PendingQuestion>;
  turns: ProviderThreadTurnSnapshot[];
  turnId: TurnId | undefined;
  turnSettled: Deferred.Deferred<void> | undefined;
  cancelled: boolean;
  stopped: boolean;
  readonly stoppedSignal: Deferred.Deferred<void>;
  managedPrompt: string | undefined;
}

export function miniMaxPermissionOption(
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
    (kind === "allow_always"
      ? request.options.find((option) => option.kind === "allow_once")?.optionId
      : undefined)
  );
}

export const makeMiniMaxAdapter = Effect.fn("makeMiniMaxAdapter")(function* (
  config: MiniMaxSettings,
  options: {
    readonly instanceId: ProviderInstanceId;
    readonly dispatchPromptInBackground?: boolean;
    readonly protocolLogging?: AcpSessionRuntimeOptions["protocolLogging"];
    readonly resolveSessionEnvironment: () => Effect.Effect<
      NodeJS.ProcessEnv,
      ProviderAdapterError
    >;
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
  const emit = Effect.fn("minimax.emit")(function* (
    threadId: ThreadId,
    event: Pick<ProviderRuntimeEvent, "type" | "payload"> & {
      readonly turnId?: TurnId;
      readonly requestId?: RuntimeRequestId;
    },
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
    Effect.all([
      Effect.forEach(ctx.pending.values(), (pending) => Deferred.succeed(pending, "cancel"), {
        discard: true,
      }),
      Effect.forEach(ctx.inputs.values(), (pending) => Deferred.succeed(pending.answer, {}), {
        discard: true,
      }),
    ]).pipe(Effect.asVoid);
  const finish = Effect.fn("minimax.finish")(function* (
    ctx: SessionContext,
    turnId: TurnId,
    stopReason: string,
    errorMessage?: string,
  ) {
    if (ctx.turnId !== turnId || ctx.stopped) return;
    const settled = ctx.turnSettled;
    ctx.turnId = undefined;
    ctx.turnSettled = undefined;
    const { activeTurnId: _active, ...rest } = ctx.session;
    ctx.session = { ...rest, status: errorMessage ? "error" : "ready", updatedAt: yield* now };
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
      payload: { state: errorMessage ? "error" : "ready" },
    });
    if (settled) yield* Deferred.succeed(settled, undefined);
  });
  const stop = Effect.fn("minimax.stop")(function* (ctx: SessionContext) {
    ctx.cancelled = true;
    yield* cancelPending(ctx);
    if (ctx.turnId) yield* finish(ctx, ctx.turnId, "cancelled");
    ctx.stopped = true;
    yield* Deferred.succeed(ctx.stoppedSignal, undefined);
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
      payload: { reason: "MiniMax Code ACP process stopped" },
    });
    return result;
  });
  const applyModel = Effect.fn("minimax.applyModel")(function* (
    acp: AcpSessionRuntime["Service"],
    threadId: ThreadId,
    model: string,
    selections?: ProviderOptionSelections,
  ) {
    yield* checked("session/set_config_option", () => miniMaxRequestedEffort(model, selections));
    const configOptions = yield* acp.getConfigOptions;
    const value = yield* checked("session/set_config_option", () =>
      resolveMiniMaxModelValue(configOptions, model, selections),
    );
    yield* acp
      .setModel(value)
      .pipe(
        Effect.mapError((cause) =>
          mapAcpToAdapterError(PROVIDER, threadId, "session/set_config_option", cause),
        ),
      );
    const refreshed = yield* acp.getConfigOptions;
    const effort = yield* checked("session/set_config_option", () =>
      miniMaxEffortValue(refreshed, model, selections),
    );
    if (effort !== undefined)
      yield* acp
        .setConfigOption("thinkingEffort", effort)
        .pipe(
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/set_config_option", cause),
          ),
        );
  });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (!config.enabled) return yield* error("startSession", "MiniMax Code is disabled.");
        if (input.provider !== undefined && input.provider !== PROVIDER)
          return yield* error("startSession", "Expected the MiniMax Code provider.");
        if (!input.cwd?.trim())
          return yield* error("startSession", "A project folder is required.");
        if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId)
          return yield* error(
            "modelSelection",
            "The selected model belongs to another harness instance.",
          );
        const selection = input.modelSelection;
        const model = selection?.model.trim() || config.model.trim();
        if (!model) return yield* error("startSession", "Choose a MiniMax Code model.");
        const resume = decodeResume(input.resumeCursor);
        if (input.resumeCursor !== undefined && resume._tag === "None")
          return yield* error(
            "startSession",
            "This cursor does not identify a MiniMax Code ACP session.",
          );
        if (input.resumePolicy === "require-existing" && resume._tag === "None")
          return yield* error(
            "startSession",
            "A saved MiniMax Code session cursor is required. Workjet will not create a replacement session.",
          );
        const sourceProfile = yield* admitWorkerSourceNativeProfile(input, PROVIDER);
        const environment =
          sourceProfile?.environment ?? (yield* options.resolveSessionEnvironment());
        const runtimeConfig = sourceProfile
          ? { ...config, dataDirectory: sourceProfile.directory }
          : config;
        const profileKey = NodeCrypto.createHash("sha256")
          .update(
            encodeProfileKey([
              options.instanceId,
              runtimeConfig.dataDirectory ||
                environment.MINIMAX_DATA_DIR ||
                environment.MAVIS_DATA_DIR ||
                "default",
              environment.HOME || "",
            ]),
          )
          .digest("hex");
        if (resume._tag === "Some" && resume.value.profileKey !== profileKey)
          return yield* error(
            "startSession",
            "The saved MiniMax Code session belongs to a different profile. Select its original harness profile to resume.",
          );
        const previous = sessions.get(input.threadId);
        // Finish an active turn before loading its persisted history. Keep an idle
        // session available until its replacement has authenticated and configured.
        if (previous?.turnId) yield* stop(previous);
        const scope = yield* Scope.make("sequential");
        const processes: ProviderTrackedProcess[] = [];
        const pending = new Map<ApprovalRequestId, Deferred.Deferred<ProviderApprovalDecision>>();
        const inputs = new Map<ApprovalRequestId, PendingQuestion>();
        const managed = readMcpProviderSession(input.threadId);
        let childExit: ChildProcessSpawner.ChildProcessHandle["exitCode"] | undefined;
        let transferred = false;
        const acp = yield* makeMiniMaxAcpRuntime({
          config: runtimeConfig,
          environment,
          spawner,
          cwd: input.cwd,
          clientInfo: { name: "workjet", version: "1" },
          ...(options.protocolLogging ? { protocolLogging: options.protocolLogging } : {}),
          ...(resume._tag === "Some"
            ? { resumeSessionId: resume.value.sessionId, requireLoadResponse: true }
            : {}),
          mcpServers: managed
            ? [
                {
                  type: "http",
                  name: "workjet",
                  url: managed.endpoint,
                  headers: [{ name: "Authorization", value: managed.authorizationHeader }],
                },
              ]
            : [],
          onProcessSpawn: (handle) => {
            processes.push(trackedChildProcess(handle));
            childExit = handle.exitCode;
          },
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
              if (
                !ctx ||
                ctx.cancelled ||
                ctx.stopped ||
                params.sessionId !== (ctx.session.resumeCursor as { sessionId: string }).sessionId
              )
                return { outcome: { outcome: "cancelled" as const } };
              if (
                ctx.session.runtimeMode === "full-access" &&
                !params.options.some((option) => option.optionId.startsWith("questionnaire:"))
              ) {
                const optionId = miniMaxPermissionOption(params, "accept");
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
              yield* publish(
                makeAcpRequestOpenedEvent({
                  stamp: yield* stamp,
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx.turnId,
                  requestId: RuntimeRequestId.make(requestId),
                  permissionRequest: parsed,
                  detail: parsed.detail ?? "MiniMax Code requests tool permission",
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
                  turnId: ctx.turnId,
                  requestId: RuntimeRequestId.make(requestId),
                  permissionRequest: parsed,
                  decision: resolved,
                }),
              );
              const optionId = ctx.cancelled
                ? undefined
                : miniMaxPermissionOption(params, resolved);
              return {
                outcome: optionId
                  ? { outcome: "selected" as const, optionId }
                  : { outcome: "cancelled" as const },
              };
            }),
          );
          yield* acp.handleExtRequest("elicitation/create", MiniMaxElicitationRequest, (params) =>
            Effect.gen(function* () {
              const ctx = sessions.get(input.threadId);
              if (
                !ctx ||
                ctx.cancelled ||
                ctx.stopped ||
                params.sessionId !== (ctx.session.resumeCursor as { sessionId: string }).sessionId
              )
                return { action: "cancel" as const };
              const form = yield* Effect.try({
                try: () => miniMaxElicitationForm(params),
                catch: () =>
                  new AcpRequestError({
                    code: -32602,
                    errorMessage: "MiniMax Code supplied an unsupported question form.",
                  }),
              });
              const requestId = ApprovalRequestId.make(NodeCrypto.randomUUID());
              const answer = yield* Deferred.make<ProviderUserInputAnswers>();
              inputs.set(requestId, { answer, form });
              yield* emit(input.threadId, {
                type: "user-input.requested",
                ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
                requestId: RuntimeRequestId.make(requestId),
                payload: { questions: form.questions },
              });
              const answers = yield* Deferred.await(answer).pipe(
                Effect.ensuring(Effect.sync(() => inputs.delete(requestId))),
              );
              yield* emit(input.threadId, {
                type: "user-input.resolved",
                ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
                requestId: RuntimeRequestId.make(requestId),
                payload: { answers },
              });
              const content = yield* Effect.try({
                try: () => form.content(answers),
                catch: () =>
                  new AcpRequestError({
                    code: -32602,
                    errorMessage: "The question response does not match the MiniMax Code form.",
                  }),
              });
              return content && !ctx.cancelled
                ? { action: "accept" as const, content }
                : { action: "cancel" as const };
            }),
          );
          const started = yield* withDeadline(
            "session/start",
            acp
              .start()
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
                ),
              ),
          );
          if (
            started.initializeResult.agentInfo?.name !== "minimax-code" ||
            started.initializeResult.agentInfo.version !== MINIMAX_CODE_RELEASE.version
          )
            return yield* error(
              "startSession",
              `Select MiniMax Code ${MINIMAX_CODE_RELEASE.version} executable.`,
            );
          if (input.runtimeMode !== "full-access") {
            const configOptions = yield* acp.getConfigOptions;
            yield* checked("session/permissionMode", () =>
              assertMiniMaxApprovalMode(configOptions),
            );
          }
          yield* withDeadline(
            "session/set_config_option",
            applyModel(acp, input.threadId, model, selection?.options),
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
            resumeCursor: { protocol: "minimax-acp", sessionId: started.sessionId, profileKey },
            createdAt,
            updatedAt: createdAt,
          };
          const ctx: SessionContext = {
            session,
            acp,
            scope,
            processes,
            pending,
            inputs,
            turns: [],
            turnId: undefined,
            turnSettled: undefined,
            cancelled: false,
            stopped: false,
            stoppedSignal: yield* Deferred.make<void>(),
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
                  threadId: input.threadId,
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
                  case "ThoughtDelta":
                    yield* publish(
                      makeAcpContentDeltaEvent({
                        ...common,
                        text: event.text,
                        streamKind: "reasoning_text",
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
          if (previous && !previous.stopped) yield* stop(previous);
          sessions.set(input.threadId, ctx);
          transferred = true;
          if (childExit)
            yield* childExit.pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.gen(function* () {
                  if (ctx.stopped) return;
                  yield* cancelPending(ctx);
                  if (ctx.turnId)
                    yield* finish(
                      ctx,
                      ctx.turnId,
                      "error",
                      "MiniMax Code disconnected. Resume the saved session to reconnect.",
                    );
                  ctx.session = { ...ctx.session, status: "error", updatedAt: yield* now };
                  yield* emit(input.threadId, {
                    type: "session.state.changed",
                    payload: { state: "error", reason: "MiniMax Code process exited" },
                  });
                  yield* emit(input.threadId, {
                    type: "session.exited",
                    payload: { reason: "MiniMax Code process exited" },
                  });
                }),
              ),
              Effect.forkIn(scope),
            );
          yield* emit(input.threadId, {
            type: "session.started",
            payload: { resume: started.initializeResult },
          });
          yield* emit(input.threadId, {
            type: "thread.started",
            payload: { providerThreadId: started.sessionId },
          });
          yield* emit(input.threadId, {
            type: "session.state.changed",
            payload: { state: "ready", reason: "MiniMax Code ACP session ready" },
          });
          return session;
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() => (transferred ? Effect.void : Scope.close(scope, Exit.void))),
          ),
        );
      }),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const { ctx, turnId, model } = yield* lock.withPermit(
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          if (ctx.session.status === "error")
            return yield* error("sendTurn", "Resume the saved MiniMax Code session to reconnect.");
          if (ctx.turnId)
            return yield* error(
              "sendTurn",
              "MiniMax Code is already answering. Stop the current turn first.",
            );
          if (input.attachments?.length)
            return yield* error(
              "sendTurn",
              "This MiniMax Code ACP release advertises text prompts only.",
            );
          if (!input.input?.trim()) return yield* error("sendTurn", "A text prompt is required.");
          if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId)
            return yield* error(
              "modelSelection",
              "The selected model belongs to another harness instance.",
            );
          const model = input.modelSelection?.model.trim() || ctx.session.model;
          if (!model) return yield* error("sendTurn", "Choose a MiniMax Code model.");
          const configOptions = yield* ctx.acp.getConfigOptions;
          if (ctx.session.runtimeMode !== "full-access")
            yield* checked("session/permissionMode", () =>
              assertMiniMaxApprovalMode(configOptions),
            );
          yield* checked("session/set_config_option", () =>
            resolveMiniMaxModelValue(configOptions, model, input.modelSelection?.options),
          );
          yield* checked("session/set_config_option", () =>
            miniMaxRequestedEffort(model, input.modelSelection?.options),
          );
          if (model === ctx.session.model)
            yield* checked("session/set_config_option", () =>
              miniMaxEffortValue(configOptions, model, input.modelSelection?.options),
            );
          const turnId = TurnId.make(NodeCrypto.randomUUID());
          ctx.turnSettled = yield* Deferred.make<void>();
          ctx.cancelled = false;
          ctx.turnId = turnId;
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* now,
          };
          return { ctx, turnId, model };
        }),
      );
      const completePrompt = Effect.gen(function* () {
        const selection = input.modelSelection;
        yield* withDeadline(
          "session/set_config_option",
          applyModel(ctx.acp, input.threadId, model, selection?.options),
        );
        ctx.session = { ...ctx.session, model };
        const mode = input.interactionMode === "plan" ? "plan" : "default";
        const modes = yield* ctx.acp.getModeState;
        if (!modes?.availableModes.some((entry) => entry.id === mode))
          return yield* error("sendTurn", `MiniMax Code does not advertise ${mode} mode.`);
        if (modes.currentModeId !== mode)
          yield* withDeadline(
            "session/set_mode",
            ctx.acp
              .request("session/set_mode", {
                sessionId: (ctx.session.resumeCursor as { sessionId: string }).sessionId,
                modeId: mode,
              })
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
                ),
              ),
          );
        if (ctx.cancelled || ctx.stopped) {
          yield* finish(ctx, turnId, "cancelled");
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }
        yield* emit(input.threadId, { type: "turn.started", turnId, payload: { model } });
        const inputText = input.input ?? "";
        const text = ctx.managedPrompt
          ? `<workjet_managed_instructions>\n${ctx.managedPrompt}\n</workjet_managed_instructions>\n\n${inputText}`
          : inputText;
        const prompt = [{ type: "text" as const, text }];
        const result = yield* ctx.acp
          .prompt({ prompt })
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause),
            ),
          );
        // Stop closes the event consumer. Its signal also releases an in-flight
        // drain barrier, so a cancelled prompt cannot wait on that closed consumer.
        yield* Effect.raceFirst(ctx.acp.drainEvents, Deferred.await(ctx.stoppedSignal));
        if (ctx.stopped)
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        ctx.managedPrompt = undefined;
        ctx.turns = [...ctx.turns, { id: turnId, items: [{ prompt, result }] }];
        yield* finish(ctx, turnId, result.stopReason);
        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      }).pipe(
        Effect.tapError((cause) => finish(ctx, turnId, "error", cause.message)),
        Effect.ensuring(
          Effect.suspend(() =>
            ctx.turnId === turnId ? finish(ctx, turnId, "cancelled") : Effect.void,
          ),
        ),
      );
      if (options.dispatchPromptInBackground) {
        yield* completePrompt.pipe(Effect.ignore, Effect.forkIn(ctx.scope));
        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      }
      return yield* completePrompt;
    });
  const adapter = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" as const },
    startSession,
    sendTurn,
    interruptTurn: (threadId, turnId = undefined) =>
      lock.withPermit(
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (!ctx.turnId || (turnId && ctx.turnId !== turnId)) return;
          const settled = ctx.turnSettled;
          ctx.cancelled = true;
          yield* cancelPending(ctx);
          yield* withDeadline(
            "session/cancel",
            ctx.acp.cancel.pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause),
              ),
              Effect.andThen(settled ? Deferred.await(settled) : Effect.void),
            ),
          ).pipe(
            Effect.tapError((cause) =>
              Effect.gen(function* () {
                if (ctx.turnId) yield* finish(ctx, ctx.turnId, "error", cause.message);
                yield* stop(ctx);
              }),
            ),
          );
        }),
      ),
    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const request = ctx.pending.get(requestId);
        if (!request || ctx.cancelled)
          return yield* error(
            "respondToRequest",
            "This MiniMax Code permission request is no longer pending.",
          );
        const accepted = yield* Deferred.succeed(request, decision);
        if (!accepted)
          return yield* error(
            "respondToRequest",
            "This MiniMax Code permission request has already been answered.",
          );
      }),
    respondToUserInput: (threadId, requestId, answers) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const request = ctx.inputs.get(requestId);
        if (!request || ctx.cancelled)
          return yield* error(
            "respondToUserInput",
            "This MiniMax Code question is no longer pending.",
          );
        yield* checked("respondToUserInput", () => request.form.content(answers));
        const accepted = yield* Deferred.succeed(request.answer, answers);
        if (!accepted)
          return yield* error(
            "respondToUserInput",
            "This MiniMax Code question has already been answered.",
          );
      }),
    stopSession: (threadId) => lock.withPermit(Effect.flatMap(requireSession(threadId), stop)),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: ctx.turns })),
    rollbackThread: () =>
      Effect.fail(
        error("rollbackThread", "MiniMax Code ACP does not advertise transcript rollback."),
      ),
    stopAll: () => Effect.forEach([...sessions.values()], stop, { discard: true }),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
  yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
  return adapter;
});
