import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  WorkjetConnectionId,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@workjet/contracts";
import { createModelSelection } from "@workjet/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@workjet/contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
  reconcileCrewTerminalOutboxWithRetry,
  repeatCrewTerminalOutbox,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { CtoxCrewSessionBootstrap } from "../../mcp/CtoxCrewSessionBootstrap.ts";
import { CtoxCrewTurnAdmission } from "../../workjet/ctox/CtoxCrewTurnAdmission.ts";
import { CtoxNativeRequestError } from "../../workjet/ctox/CtoxNativeRequests.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  effectIt.effect("retries a deferred Crew terminal report once after thirty seconds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const reconcileTerminalOutbox = vi.fn(() =>
          Effect.sync(() => {
            calls += 1;
            return calls === 1
              ? { reported: 0, deferred: 1, pending: 0, truncated: false }
              : { reported: 1, deferred: 0, pending: 0, truncated: false };
          }),
        );
        const admission = {
          reconcileTerminalOutbox,
        } as unknown as CtoxCrewTurnAdmission["Service"];
        yield* reconcileCrewTerminalOutboxWithRetry(admission);
        expect(reconcileTerminalOutbox).toHaveBeenCalledTimes(1);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(29));
        expect(reconcileTerminalOutbox).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.yieldNow;
        expect(reconcileTerminalOutbox).toHaveBeenCalledTimes(2);
      }),
    ),
  );
  effectIt.effect("keeps retrying a persisted Crew terminal report after a transient outage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const reconcileTerminalOutbox = vi.fn(() =>
          Effect.suspend(() => {
            calls += 1;
            return calls === 1
              ? Effect.fail({ _tag: "TemporaryNativeOutage" as const })
              : Effect.succeed({ reported: 1, deferred: 0, pending: 0, truncated: false });
          }),
        );
        const admission = {
          reconcileTerminalOutbox,
        } as unknown as CtoxCrewTurnAdmission["Service"];
        yield* Effect.forkScoped(repeatCrewTerminalOutbox(admission, Duration.seconds(1)));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.yieldNow;
        expect(reconcileTerminalOutbox).toHaveBeenCalledTimes(1);
        for (let attempt = 0; attempt < 5 && calls < 2; attempt += 1) {
          yield* TestClock.adjust(Duration.seconds(1));
          yield* Effect.yieldNow;
        }
        expect(reconcileTerminalOutbox).toHaveBeenCalledTimes(2);
      }),
    ),
  );
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly threadWorkjetConfig?: WorkjetThreadConfig;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly requiresNewThreadForModelChange?: boolean;
    readonly titleRegenerationCompletionDispatchFailures?: number;
    readonly titleRegenerationBeforeStart?: "one" | "two";
    readonly startSessionEffect?: (
      session: ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderAdapterRequestError>;
    readonly crewAdmission?: CtoxCrewTurnAdmission["Service"];
    readonly initialProviderSession?: boolean;
    readonly providerBinding?: ProviderRuntimeBinding;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workjet-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const crewBound =
      input?.threadWorkjetConfig?.schemaVersion === 2 &&
      input.threadWorkjetConfig.ctoxCrewChat !== undefined;
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSessionEffect = input?.startSessionEffect;
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor:
          resumeCursor ??
          (crewBound && provider === "codex"
            ? { threadId: `codex-crew-${sessionIndex}` }
            : { opaque: `resume-${sessionIndex}` }),
        createdAt: now,
        updatedAt: now,
      };
      return (startSessionEffect?.(session) ?? Effect.succeed(session)).pipe(
        Effect.tap((startedSession) =>
          Effect.sync(() => {
            runtimeSessions.push(startedSession);
          }),
        ),
      );
    });
    const sendTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return { terminated: false as const, method: "cooperative" as const, pids: [] };
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
        return { terminated: true as const, method: "cooperative" as const, pids: [] };
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const providerSnapshots = [
      {
        instanceId: modelSelection.instanceId,
        ...(input?.requiresNewThreadForModelChange === true
          ? { requiresNewThreadForModelChange: true }
          : {}),
      },
    ];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    let titleRegenerationCompletionDispatchAttempts = 0;
    const reactorOrchestrationLayer = Layer.effect(
      OrchestrationEngineService,
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        return {
          readEvents: engine.readEvents,
          runTurnStartIfActive: engine.runTurnStartIfActive,
          dispatch: (command) => {
            if (command.type === "thread.title.regeneration.complete") {
              titleRegenerationCompletionDispatchAttempts += 1;
              if (
                titleRegenerationCompletionDispatchAttempts <=
                (input?.titleRegenerationCompletionDispatchFailures ?? 0)
              ) {
                return Effect.die(new Error("Injected title regeneration completion failure"));
              }
            }
            return engine.dispatch(command);
          },
          get streamDomainEvents() {
            return engine.streamDomainEvents;
          },
          latestSequence: engine.latestSequence,
        } satisfies OrchestrationEngineService["Service"];
      }),
    ).pipe(Layer.provide(orchestrationLayer));
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(reactorOrchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(
        input?.crewAdmission
          ? Layer.succeed(CtoxCrewTurnAdmission, input.crewAdmission)
          : Layer.empty,
      ),
      Layer.provideMerge(
        input?.providerBinding
          ? Layer.mock(ProviderSessionDirectory)({
              getBinding: () => Effect.succeed(Option.some(input.providerBinding!)),
            })
          : Layer.empty,
      ),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const runEffect = <A, E>(effect: Effect.Effect<A, E>) => runtime!.runPromise(effect);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: input?.threadWorkjetConfig ?? DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    if (input?.titleRegenerationBeforeStart === "two") {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-2"),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-1"),
          title: "Thread 2",
          modelSelection: modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    }
    const titleRegenerationThreadIds =
      input?.titleRegenerationBeforeStart === "two"
        ? [ThreadId.make("thread-1"), ThreadId.make("thread-2")]
        : input?.titleRegenerationBeforeStart === "one"
          ? [ThreadId.make("thread-1")]
          : [];
    for (const [index, threadId] of titleRegenerationThreadIds.entries()) {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(
            `cmd-thread-title-regeneration-before-reactor-start-${index + 1}`,
          ),
          threadId,
          regenerateTitle: true,
        }),
      );
    }
    if (input?.initialProviderSession) {
      await Effect.runPromise(
        startSession(ThreadId.make("thread-1"), {
          threadId: ThreadId.make("thread-1"),
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          runtimeMode: "approval-required",
        }),
      );
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-previous-crew-session"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: ProviderDriverKind.make("codex"),
            providerInstanceId: modelSelection.instanceId,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
    }

    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      stateDir,
      drain,
      runEffect,
      get titleRegenerationCompletionDispatchAttempts() {
        return titleRegenerationCompletionDispatchAttempts;
      },
    };
  }

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("starts a fresh provider session for each claimed Crew turn", async () => {
    const binding = {
      instanceId: "native-instance",
      connectionId: WorkjetConnectionId.make("connection"),
      chatId: "workjet_private_chat",
    };
    let nextAttempt = 0;
    const bindProviderSession = vi.fn(() => Effect.void);
    const admission = {
      prepare: ({
        threadId,
        requestId,
        providerInstanceId,
      }: {
        threadId: ThreadId;
        requestId: string;
        providerInstanceId: ProviderInstanceId;
      }) => {
        const attemptId = `attempt-${++nextAttempt}`;
        return Effect.succeed({
          state: "ready" as const,
          identity: {
            threadId,
            connectionId: binding.connectionId,
            instanceId: binding.instanceId,
            requestKey: requestId,
          },
          claim: { attemptId, prompt: `native prompt ${attemptId}`, harness: "codex" },
          bootstrap: CtoxCrewSessionBootstrap.of({
            binding,
            nativeInstructions: `native instructions ${attemptId}`,
            capability: {
              threadId,
              providerInstanceId,
              attemptId,
              refreshContext: () => Effect.die("unused"),
              updatePlan: () => Effect.die("unused"),
              report: () => Effect.die("unused"),
            },
          }),
        });
      },
      recover: () => Effect.die("unused"),
      bindProviderSession,
      bindProviderTurn: () => Effect.void,
      reconcileTerminalOutbox: () => Effect.succeed({ reported: 0, truncated: false }),
      readTerminalState: () => Effect.succeed(null),
      listRecoveryCandidates: () => Effect.succeed({ candidates: [], nextSequence: null }),
    } as unknown as CtoxCrewTurnAdmission["Service"];
    const harness = await createHarness({
      threadWorkjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, ctoxCrewChat: binding },
      crewAdmission: admission,
    });
    for (const turn of [1, 2]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-crew-turn-${turn}`),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId(`crew-message-${turn}`),
            role: "user",
            text: `do Crew work ${turn}`,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: `2026-01-01T00:00:0${turn}.000Z`,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === turn, 3_000).catch(
        async (cause: unknown) => {
          const thread = (await harness.readModel()).threads.find(
            (entry) => entry.id === ThreadId.make("thread-1"),
          );
          throw new Error(
            `Crew turn ${turn} stalled: ${JSON.stringify({
              starts: harness.startSession.mock.calls.length,
              stops: harness.stopSession.mock.calls.length,
              admissions: nextAttempt,
              activities: thread?.activities,
            })}`,
            { cause },
          );
        },
      );
    }
    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.stopSession).toHaveBeenCalledTimes(1);
    expect(bindProviderSession).toHaveBeenCalledTimes(2);
    expect(
      harness.sendTurn.mock.calls.map(([request]) => (request as { input?: string }).input),
    ).toEqual(["native prompt attempt-1", "native prompt attempt-2"]);
  });

  it("replaces a resting provider route before dispatching a recovered Crew claim", async () => {
    const threadId = ThreadId.make("thread-1");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const binding = {
      instanceId: "native-instance",
      connectionId: WorkjetConnectionId.make("connection"),
      chatId: "workjet_private_chat",
    };
    const candidate = {
      identity: {
        threadId,
        connectionId: binding.connectionId,
        instanceId: binding.instanceId,
        requestKey: "turn-recovery-key",
      },
      requestId: "command:recovered-crew",
    };
    const recovered = vi.fn(() =>
      Effect.succeed({
        state: "ready" as const,
        identity: candidate.identity,
        claim: {
          attemptId: "recovered-attempt",
          prompt: "recovered native work",
          harness: "codex",
        },
        bootstrap: CtoxCrewSessionBootstrap.of({
          binding,
          nativeInstructions: "recovered native instructions",
          capability: {
            threadId,
            providerInstanceId,
            attemptId: "recovered-attempt",
            refreshContext: () => Effect.die("unused"),
            updatePlan: () => Effect.die("unused"),
            report: () => Effect.die("unused"),
          },
        }),
      }),
    );
    const bindProviderSession = vi.fn(() => Effect.void);
    const admission = {
      prepare: () => Effect.die("unused"),
      recover: recovered,
      bindProviderSession,
      bindProviderTurn: () => Effect.void,
      reconcileTerminalOutbox: () => Effect.succeed({ reported: 0, truncated: false }),
      readTerminalState: () => Effect.succeed(null),
      listRecoveryCandidates: () =>
        Effect.succeed({ candidates: [{ ...candidate, sequence: 1 }], nextSequence: null }),
    } as unknown as CtoxCrewTurnAdmission["Service"];
    const harness = await createHarness({
      threadWorkjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, ctoxCrewChat: binding },
      crewAdmission: admission,
      initialProviderSession: true,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(harness.stopSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(bindProviderSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      requestId: candidate.requestId,
      input: "recovered native work",
    });
  });

  it("continues a claimed Crew recovery beyond the first sixteen startup pages", async () => {
    const threadId = ThreadId.make("thread-1");
    const binding = {
      instanceId: "native-instance",
      connectionId: WorkjetConnectionId.make("connection"),
      chatId: "workjet_private_chat",
    };
    const candidate = {
      sequence: 1025,
      identity: {
        threadId,
        connectionId: binding.connectionId,
        instanceId: binding.instanceId,
        requestKey: "claimed-after-page-sixteen",
      },
      requestId: "command:claimed-after-page-sixteen",
    };
    const listRecoveryCandidates = vi.fn((afterSequence: number) =>
      Effect.succeed(
        afterSequence < 1024
          ? { candidates: [], nextSequence: afterSequence + 64 }
          : { candidates: [candidate], nextSequence: null },
      ),
    );
    const recover = vi.fn(() =>
      Effect.succeed({
        state: "resume-required" as const,
        identity: candidate.identity,
        attemptId: "existing-claimed-attempt",
      }),
    );
    const admission = {
      listRecoveryCandidates,
      recover,
      readTerminalState: () => Effect.succeed(null),
      reconcileTerminalOutbox: () =>
        Effect.succeed({ reported: 0, deferred: 0, pending: 0, truncated: false }),
    } as unknown as CtoxCrewTurnAdmission["Service"];
    const harness = await createHarness({
      threadWorkjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, ctoxCrewChat: binding },
      crewAdmission: admission,
    });
    await waitFor(() => listRecoveryCandidates.mock.calls.length === 16);
    expect(recover).not.toHaveBeenCalled();
    await Effect.runPromise(Effect.sleep(Duration.seconds(31)));
    await waitFor(() => recover.mock.calls.length === 1);
    expect(listRecoveryCandidates.mock.calls.at(-1)?.[0]).toBe(1024);
    expect(harness.sendTurn).not.toHaveBeenCalled();
  }, 40_000);

  for (const driver of ["codex", "grok"] as const)
    it(`continues a claimed Crew attempt once on its exact saved ${driver} conversation`, async () => {
      const threadId = ThreadId.make("thread-1");
      const providerInstanceId = ProviderInstanceId.make(driver);
      const binding = {
        instanceId: "native-instance",
        connectionId: WorkjetConnectionId.make("connection"),
        chatId: "workjet_private_chat",
      };
      const candidate = {
        identity: {
          threadId,
          connectionId: binding.connectionId,
          instanceId: binding.instanceId,
          requestKey: "turn-claimed-key",
        },
        requestId: "command:claimed-crew",
      };
      const resumeCursor =
        driver === "codex"
          ? { threadId: "codex-saved-thread" }
          : { schemaVersion: 1, sessionId: "grok-saved-session" };
      const providerResumeIdentity =
        driver === "codex" ? "codex-saved-thread" : "grok-saved-session";
      const recover = vi.fn(() =>
        Effect.succeed({
          state: "resume-required" as const,
          attemptId: "claimed-attempt",
          identity: candidate.identity,
        }),
      );
      const reissueClaimed = vi.fn(() =>
        Effect.succeed({
          claim: { attemptId: "claimed-attempt" },
          bootstrap: CtoxCrewSessionBootstrap.of({
            binding,
            nativeInstructions: "continue this existing attempt",
            capability: {
              threadId,
              providerInstanceId,
              attemptId: "claimed-attempt",
              refreshContext: () => Effect.die("unused"),
              updatePlan: () => Effect.die("unused"),
              report: () => Effect.die("unused"),
            },
          }),
        }),
      );
      const reserveContinuation = vi.fn(() =>
        Effect.succeed({ state: "reserved" as const, requestId: "ctox-recovery:claimed-attempt" }),
      );
      const bindProviderTurn = vi.fn(() => Effect.void);
      const admission = {
        prepare: () => Effect.die("unused"),
        recover,
        reissueClaimed,
        reserveContinuation,
        bindProviderSession: () => Effect.die("unused"),
        bindProviderTurn,
        reconcileTerminalOutbox: () => Effect.succeed({ reported: 0, truncated: false }),
        readTerminalState: () => Effect.succeed(null),
        listRecoveryCandidates: () =>
          Effect.succeed({ candidates: [{ ...candidate, sequence: 1 }], nextSequence: null }),
      } as unknown as CtoxCrewTurnAdmission["Service"];
      const harness = await createHarness({
        threadWorkjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, ctoxCrewChat: binding },
        threadModelSelection: { instanceId: providerInstanceId, model: "test-model" },
        crewAdmission: admission,
        providerBinding: {
          threadId,
          provider: ProviderDriverKind.make(driver),
          providerInstanceId,
          resumeCursor,
        },
      });
      await waitFor(() => bindProviderTurn.mock.calls.length === 1);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(reissueClaimed).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining(candidate),
          binding,
          providerInstanceId,
          providerThreadId: threadId,
          attemptId: "claimed-attempt",
          codexResumeThreadId: driver === "codex" ? providerResumeIdentity : null,
          providerDriverKind: ProviderDriverKind.make(driver),
          providerResumeIdentity,
        }),
      );
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        resumeCursor,
        resumePolicy: "require-existing",
      });
      expect(reserveContinuation).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        requestId: "ctox-recovery:claimed-attempt",
      });
      expect(String((harness.sendTurn.mock.calls[0]?.[0] as { input?: string }).input)).toContain(
        "Continue the existing CTOX Crew attempt claimed-attempt",
      );
      expect(bindProviderTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId: "claimed-attempt",
          providerTurnId: asTurnId("turn-1"),
        }),
      );
    });

  it("retains a claimed Crew attempt when the directory cursor changed", async () => {
    const threadId = ThreadId.make("thread-1");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const binding = {
      instanceId: "native-instance",
      connectionId: WorkjetConnectionId.make("connection"),
      chatId: "workjet_private_chat",
    };
    const candidate = {
      identity: {
        threadId,
        connectionId: binding.connectionId,
        instanceId: binding.instanceId,
        requestKey: "changed-cursor-key",
      },
      requestId: "command:changed-cursor",
    };
    const reissueClaimed = vi.fn(({ codexResumeThreadId }: { codexResumeThreadId: string }) =>
      codexResumeThreadId === "original-codex-thread"
        ? Effect.die("unexpected original cursor")
        : Effect.fail(new CtoxNativeRequestError({ reason: "native-task-reference-conflict" })),
    );
    const reserveContinuation = vi.fn(() => Effect.die("changed cursor must not dispatch"));
    const admission = {
      recover: () =>
        Effect.succeed({
          state: "resume-required" as const,
          attemptId: "claimed-attempt",
          identity: candidate.identity,
        }),
      reissueClaimed,
      reserveContinuation,
      readTerminalState: () => Effect.succeed(null),
      reconcileTerminalOutbox: () => Effect.succeed({ reported: 0, truncated: false }),
      listRecoveryCandidates: () =>
        Effect.succeed({ candidates: [{ ...candidate, sequence: 1 }], nextSequence: null }),
    } as unknown as CtoxCrewTurnAdmission["Service"];
    const harness = await createHarness({
      threadWorkjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, ctoxCrewChat: binding },
      crewAdmission: admission,
      providerBinding: {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId,
        resumeCursor: { threadId: "changed-codex-thread" },
      },
    });
    await waitFor(() => reissueClaimed.mock.calls.length === 1);
    await Effect.runPromise(Effect.yieldNow);
    expect(reissueClaimed).toHaveBeenCalledWith(
      expect.objectContaining({ codexResumeThreadId: "changed-codex-thread" }),
    );
    expect(reserveContinuation).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("redrives a pending native Crew offer after its CTOX connection changes", async () => {
    const threadId = ThreadId.make("thread-1");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const binding = {
      instanceId: "native-instance",
      connectionId: WorkjetConnectionId.make("connection"),
      chatId: "workjet_private_chat",
    };
    const candidate = {
      identity: {
        threadId,
        connectionId: binding.connectionId,
        instanceId: binding.instanceId,
        requestKey: "pending-offer-key",
      },
      requestId: "command:pending-offer",
    };
    const changes = Effect.runSync(PubSub.unbounded<void>());
    let offerReady = false;
    const recover = vi.fn(() =>
      Effect.succeed(
        offerReady
          ? {
              state: "ready" as const,
              identity: candidate.identity,
              claim: {
                attemptId: "offered-attempt",
                prompt: "native offer is ready",
                harness: "codex" as const,
              },
              bootstrap: CtoxCrewSessionBootstrap.of({
                binding,
                nativeInstructions: "native rules",
                capability: {
                  threadId,
                  providerInstanceId,
                  attemptId: "offered-attempt",
                  refreshContext: () => Effect.die("unused"),
                  updatePlan: () => Effect.die("unused"),
                  report: () => Effect.die("unused"),
                },
              }),
            }
          : { state: "awaiting-native-offer" as const, identity: candidate.identity },
      ),
    );
    const bindProviderSession = vi.fn(() => Effect.void);
    const admission = {
      recover,
      bindProviderSession,
      bindProviderTurn: () => Effect.void,
      reconcileTerminalOutbox: () =>
        Effect.succeed({ reported: 0, deferred: 0, pending: 0, truncated: false }),
      subscribeConnectionChanges: PubSub.subscribe(changes).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      listRecoveryCandidates: () =>
        Effect.succeed({ candidates: [{ ...candidate, sequence: 1 }], nextSequence: null }),
      listPendingAdmissionCandidates: () =>
        Effect.succeed({ candidates: [{ ...candidate, sequence: 1 }], nextSequence: null }),
    } as unknown as CtoxCrewTurnAdmission["Service"];
    const harness = await createHarness({
      threadWorkjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, ctoxCrewChat: binding },
      crewAdmission: admission,
    });
    await waitFor(() => recover.mock.calls.length === 1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    offerReady = true;
    await Effect.runPromise(PubSub.publish(changes, undefined));
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(bindProviderSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      requestId: candidate.requestId,
      input: "native offer is ready",
    });
  });

  it("revisits a claimed Crew attempt that appears after startup without dispatching a duplicate", async () => {
    const threadId = ThreadId.make("thread-1");
    const binding = {
      instanceId: "native-instance",
      connectionId: WorkjetConnectionId.make("connection"),
      chatId: "workjet_private_chat",
    };
    const candidate = {
      sequence: 2,
      identity: {
        threadId,
        connectionId: binding.connectionId,
        instanceId: binding.instanceId,
        requestKey: "late-claimed-request",
      },
      requestId: "command:late-claimed",
    };
    const changes = Effect.runSync(PubSub.unbounded<void>());
    let claimVisible = false;
    const recover = vi.fn(() =>
      Effect.succeed({
        state: "resume-required" as const,
        identity: candidate.identity,
        attemptId: "late-claimed-attempt",
      }),
    );
    const admission = {
      recover,
      readTerminalState: () => Effect.succeed(null),
      reconcileTerminalOutbox: () =>
        Effect.succeed({ reported: 0, deferred: 0, pending: 0, truncated: false }),
      subscribeConnectionChanges: PubSub.subscribe(changes).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      listRecoveryCandidates: () => Effect.succeed({ candidates: [], nextSequence: null }),
      listPendingAdmissionCandidates: () => Effect.succeed({ candidates: [], nextSequence: null }),
      listUnresolvedStartedCandidates: () =>
        Effect.succeed({
          candidates: claimVisible ? [candidate] : [],
          nextSequence: null,
        }),
    } as unknown as CtoxCrewTurnAdmission["Service"];
    const harness = await createHarness({
      threadWorkjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, ctoxCrewChat: binding },
      crewAdmission: admission,
    });
    expect(recover).not.toHaveBeenCalled();
    claimVisible = true;
    await Effect.runPromise(PubSub.publish(changes, undefined));
    await waitFor(() => recover.mock.calls.length === 1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    await Effect.runPromise(PubSub.publish(changes, undefined));
    await waitFor(() => recover.mock.calls.length === 2);
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("does not take over a newly claimed Crew turn while its first provider send is in flight", async () => {
    const threadId = ThreadId.make("thread-1");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const binding = {
      instanceId: "native-instance",
      connectionId: WorkjetConnectionId.make("connection"),
      chatId: "workjet_private_chat",
    };
    const candidate = {
      sequence: 1,
      identity: {
        threadId,
        connectionId: binding.connectionId,
        instanceId: binding.instanceId,
        requestKey: "slow-first-send",
      },
      requestId: "command:slow-first-send",
    };
    const changes = Effect.runSync(PubSub.unbounded<void>());
    let offerReady = false;
    let claimed = false;
    const recover = vi.fn(() =>
      Effect.sync(() => {
        if (!offerReady)
          return { state: "awaiting-native-offer" as const, identity: candidate.identity };
        if (claimed)
          return {
            state: "resume-required" as const,
            identity: candidate.identity,
            attemptId: "slow-attempt",
          };
        claimed = true;
        return {
          state: "ready" as const,
          identity: candidate.identity,
          claim: {
            attemptId: "slow-attempt",
            prompt: "original native prompt",
            harness: "codex" as const,
          },
          bootstrap: CtoxCrewSessionBootstrap.of({
            binding,
            nativeInstructions: "native rules",
            capability: {
              threadId,
              providerInstanceId,
              attemptId: "slow-attempt",
              refreshContext: () => Effect.die("unused"),
              updatePlan: () => Effect.die("unused"),
              report: () => Effect.die("unused"),
            },
          }),
        };
      }),
    );
    const reissueClaimed = vi.fn(() =>
      Effect.succeed({
        claim: { attemptId: "slow-attempt" },
        bootstrap: CtoxCrewSessionBootstrap.of({
          binding,
          nativeInstructions: "continue existing attempt",
          capability: {
            threadId,
            providerInstanceId,
            attemptId: "slow-attempt",
            refreshContext: () => Effect.die("unused"),
            updatePlan: () => Effect.die("unused"),
            report: () => Effect.die("unused"),
          },
        }),
      }),
    );
    const reserveContinuation = vi.fn(() =>
      Effect.succeed({ state: "reserved" as const, requestId: "ctox-recovery:slow-attempt" }),
    );
    const bindProviderTurn = vi.fn(() => Effect.void);
    const listStarted = vi.fn(() =>
      Effect.succeed({ candidates: claimed ? [candidate] : [], nextSequence: null }),
    );
    const admission = {
      recover,
      reissueClaimed,
      reserveContinuation,
      bindProviderSession: () => Effect.void,
      bindProviderTurn,
      readTerminalState: () => Effect.succeed(null),
      reconcileTerminalOutbox: () =>
        Effect.succeed({ reported: 0, deferred: 0, pending: 0, truncated: false }),
      subscribeConnectionChanges: PubSub.subscribe(changes).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      listRecoveryCandidates: () => Effect.succeed({ candidates: [], nextSequence: null }),
      listPendingAdmissionCandidates: () =>
        Effect.succeed({ candidates: claimed ? [] : [candidate], nextSequence: null }),
      listUnresolvedStartedCandidates: listStarted,
    } as unknown as CtoxCrewTurnAdmission["Service"];
    const harness = await createHarness({
      threadWorkjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, ctoxCrewChat: binding },
      crewAdmission: admission,
      providerBinding: {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId,
        resumeCursor: { threadId: "codex-crew-1" },
      },
    });
    let releaseFirstSend!: () => void;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    let sends = 0;
    harness.sendTurn.mockImplementation(() => {
      sends += 1;
      if (sends > 1) return Effect.succeed({ threadId, turnId: asTurnId("turn-2") });
      return Effect.promise(() => firstSendGate).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const index = harness.runtimeSessions.findIndex(
              (session) => session.threadId === threadId,
            );
            if (index >= 0)
              harness.runtimeSessions[index] = {
                ...harness.runtimeSessions[index]!,
                status: "running",
              };
          }),
        ),
        Effect.as({ threadId, turnId: asTurnId("turn-1") }),
      );
    });
    offerReady = true;
    await Effect.runPromise(PubSub.publish(changes, undefined));
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const startedDuringFirstSend = listStarted.mock.calls.length;
    await Effect.runPromise(PubSub.publish(changes, undefined));
    try {
      await waitFor(() => listStarted.mock.calls.length > startedDuringFirstSend);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(reserveContinuation).not.toHaveBeenCalled();
    } finally {
      releaseFirstSend();
    }
    await waitFor(() => bindProviderTurn.mock.calls.length === 1);
    const startedWhileRunning = listStarted.mock.calls.length;
    await Effect.runPromise(PubSub.publish(changes, undefined));
    await waitFor(() => listStarted.mock.calls.length > startedWhileRunning);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(harness.stopSession).not.toHaveBeenCalled();
    const index = harness.runtimeSessions.findIndex((session) => session.threadId === threadId);
    expect(index).toBeGreaterThanOrEqual(0);
    harness.runtimeSessions[index] = { ...harness.runtimeSessions[index]!, status: "ready" };
    await Effect.runPromise(PubSub.publish(changes, undefined));
    await waitFor(() => bindProviderTurn.mock.calls.length === 2);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(harness.stopSession).toHaveBeenCalledTimes(1);
    expect(reserveContinuation).toHaveBeenCalledTimes(1);
    expect(
      harness.sendTurn.mock.calls.map(([request]) => (request as { input?: string }).input),
    ).toEqual([
      "original native prompt",
      expect.stringContaining("Continue the existing CTOX Crew attempt slow-attempt"),
    ]);
  });

  it("does not recover a hot Crew claim while its provider session is still starting", async () => {
    const threadId = ThreadId.make("thread-1");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const binding = {
      instanceId: "native-instance",
      connectionId: WorkjetConnectionId.make("connection"),
      chatId: "workjet_private_chat",
    };
    const candidate = {
      sequence: 1,
      identity: {
        threadId,
        connectionId: binding.connectionId,
        instanceId: binding.instanceId,
        requestKey: "hot-claim",
      },
      requestId: "command:hot-claim",
    };
    const changes = Effect.runSync(PubSub.unbounded<void>());
    let claimVisible = false;
    let releaseSessionStart!: () => void;
    const sessionStartGate = new Promise<void>((resolve) => {
      releaseSessionStart = resolve;
    });
    const prepare = vi.fn(() =>
      Effect.sync(() => {
        claimVisible = true;
        return {
          state: "ready" as const,
          identity: candidate.identity,
          claim: {
            attemptId: "hot-attempt",
            prompt: "hot original prompt",
            harness: "codex" as const,
          },
          bootstrap: CtoxCrewSessionBootstrap.of({
            binding,
            nativeInstructions: "native rules",
            capability: {
              threadId,
              providerInstanceId,
              attemptId: "hot-attempt",
              refreshContext: () => Effect.die("unused"),
              updatePlan: () => Effect.die("unused"),
              report: () => Effect.die("unused"),
            },
          }),
        };
      }),
    );
    const recover = vi.fn(() =>
      Effect.succeed({
        state: "resume-required" as const,
        identity: candidate.identity,
        attemptId: "hot-attempt",
      }),
    );
    const listStarted = vi.fn(() =>
      Effect.succeed({ candidates: claimVisible ? [candidate] : [], nextSequence: null }),
    );
    const bindProviderTurn = vi.fn(() => Effect.void);
    const admission = {
      prepare,
      recover,
      bindProviderSession: () => Effect.void,
      bindProviderTurn,
      readTerminalState: () => Effect.succeed(null),
      reconcileTerminalOutbox: () =>
        Effect.succeed({ reported: 0, deferred: 0, pending: 0, truncated: false }),
      subscribeConnectionChanges: PubSub.subscribe(changes).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      listRecoveryCandidates: () => Effect.succeed({ candidates: [], nextSequence: null }),
      listPendingAdmissionCandidates: () => Effect.succeed({ candidates: [], nextSequence: null }),
      listUnresolvedStartedCandidates: listStarted,
    } as unknown as CtoxCrewTurnAdmission["Service"];
    const harness = await createHarness({
      threadWorkjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, ctoxCrewChat: binding },
      crewAdmission: admission,
      providerBinding: {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId,
        resumeCursor: { threadId: "codex-crew-1" },
      },
      startSessionEffect: (session) =>
        Effect.promise(() => sessionStartGate).pipe(Effect.as(session)),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-hot-claim"),
        threadId,
        message: {
          messageId: asMessageId("message-hot-claim"),
          role: "user",
          text: "Start the hot Crew claim",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    try {
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      expect(prepare).toHaveBeenCalledTimes(1);
      await Effect.runPromise(PubSub.publish(changes, undefined));
      await waitFor(() => listStarted.mock.calls.length === 1);
      expect(recover).not.toHaveBeenCalled();
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    } finally {
      releaseSessionStart();
    }
    await waitFor(() => bindProviderTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "hot original prompt" });
    expect(harness.stopSession).not.toHaveBeenCalled();
  });

  it("passes the thread's current Workjet config on provider start and restart", async () => {
    const initialWorkjetConfig = {
      schemaVersion: 1,
      role: "orchestrator",
      parent: null,
      managedInstructions: "Coordinate the configured capabilities.",
      enabledCapabilityIds: ["greppy"],
    } as const satisfies WorkjetThreadConfig;
    const restartedWorkjetConfig = {
      schemaVersion: 1,
      role: "standard",
      parent: null,
      managedInstructions: "Use the updated capability configuration.",
      enabledCapabilityIds: ["web-search", "web-stack-browser"],
    } as const satisfies WorkjetThreadConfig;
    const harness = await createHarness({ threadWorkjetConfig: initialWorkjetConfig });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workjet-config"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workjet-config"),
          role: "user",
          text: "start with capabilities",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      workjetConfig: initialWorkjetConfig,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.workjet-config.set",
        commandId: CommandId.make("cmd-workjet-config-update"),
        threadId: ThreadId.make("thread-1"),
        workjetConfig: restartedWorkjetConfig,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-workjet-restart"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      runtimeMode: "full-access",
      workjetConfig: restartedWorkjetConfig,
    });
  });

  effectIt.effect("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-provider"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
    }),
  );

  effectIt.effect("does not send a delayed provider turn after thread deletion", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );
      const threadId = ThreadId.make("thread-1");
      const now = "2026-01-01T00:00:00.000Z";
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-before-delete"),
        threadId,
        message: {
          messageId: asMessageId("message-before-delete"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });
      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      yield* harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-delete-during-start"),
        threadId,
      });
      yield* Effect.promise(() =>
        waitFor(async () => {
          const model = await harness.readModel();
          const thread = model.threads.find((entry) => entry.id === threadId);
          return thread !== undefined && thread.deletedAt !== null;
        }),
      );
      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => harness.drain());
      expect(harness.sendTurn).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            failStartup
              ? Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "thread.start",
                    detail: "deterministic startup failure",
                  }),
                )
              : Effect.succeed(session),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-failure"),
          role: "user",
          text: "fail once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* Effect.promise(() => harness.readModel());
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.lastError).toContain("deterministic startup failure");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      failStartup = false;
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-retry"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-retry"),
          role: "user",
          text: "retry",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      readModel = yield* Effect.promise(() => harness.readModel());
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );

  it("generates a thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
  });

  it("regenerates a thread title from the current conversation", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Resolve stale reconnect state" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-existing"),
        threadId: ThreadId.make("thread-1"),
        title: "Investigate reconnect regressions",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-title-regeneration"),
          role: "user",
          text: "Please investigate reconnect regressions after restarting the session.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        delta: "The remaining issue is stale reconnect state.",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-complete-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/provider-project",
      previousTitle: "Investigate reconnect regressions",
      message: [
        "USER:",
        "Please investigate reconnect regressions after restarting the session.",
        "",
        "ASSISTANT:",
        "The remaining issue is stale reconnect state.",
      ].join("\n"),
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Resolve stale reconnect state");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("pins the first user message when regeneration context is truncated", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const firstUserMessage = `Review subagent monitoring risks. ${"Opening context. ".repeat(200)}`;
    const recentUserMessage = `LATEST FINDING: ${"implementation detail ".repeat(320)}`;
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Review subagent monitoring risks" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-existing-long"),
        threadId: ThreadId.make("thread-1"),
        title: "Generic PR review",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-long-title-regeneration"),
          role: "user",
          text: firstUserMessage,
          attachments: [
            {
              type: "image",
              id: "opening-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-middle-turn-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("middle-message-before-long-title-regeneration"),
          role: "user",
          text: "Temporary handoff details.",
          attachments: [
            {
              type: "image",
              id: "middle-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-recent-turn-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("recent-message-before-long-title-regeneration"),
          role: "user",
          text: recentUserMessage,
          attachments: [
            {
              type: "image",
              id: "recent-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate-long"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    const input = harness.generateThreadTitle.mock.calls[0]?.[0];
    if (!input) {
      throw new Error("Expected a title generation input");
    }
    const message = input.message;
    expect(message.startsWith("USER:\nReview subagent monitoring risks.")).toBe(true);
    expect(message).toContain("[First user message truncated]");
    expect(message).toContain("[Earlier content truncated]");
    expect(message).toContain("image.png");
    expect(message).toHaveLength(8_000);
    expect(input.attachments?.map((attachment) => attachment.id)).toEqual([
      "opening-context-image",
      "recent-context-image",
    ]);
  });

  it("clears title regeneration state left pending across reactor startup", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "one",
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Thread");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("continues clearing startup title regeneration state after one completion fails", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "two",
      titleRegenerationCompletionDispatchFailures: 1,
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(2);
    const readModel = await harness.readModel();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.titleRegeneration,
    ).not.toBeNull();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-2"))?.titleRegeneration,
    ).toBeNull();
  });

  it("keeps the current title when regeneration returns the fallback", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "New thread" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep meaningful title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-fallback-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep meaningful title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("clears title regeneration state when generation fails", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep title after failure",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-failed-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep title after failure");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("retries a failed completion and continues regenerating", async () => {
    const harness = await createHarness({
      titleRegenerationCompletionDispatchFailures: 1,
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle
      .mockReturnValueOnce(Effect.succeed({ title: "Title lost to completion failure" }))
      .mockReturnValueOnce(Effect.succeed({ title: "Recovered regeneration worker" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-completion-failure"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    let readModel = await harness.readModel();
    let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Title lost to completion failure");
    expect(thread?.titleRegeneration).toBeNull();

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-after-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(2);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(3);
    readModel = await harness.readModel();
    thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Recovered regeneration worker");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("pins the first user context and attachment before the retained tail", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const firstUserContext = "USER:\nOld visual issue\n[Attachments: old-issue.png]";
    const truncationMarker = "[Earlier content truncated]\n\n";
    const retainedContext = "x".repeat(
      8_000 - firstUserContext.length - "\n\n".length - truncationMarker.length,
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-truncated-regeneration"),
          role: "user",
          text: "Old visual issue",
          attachments: [
            {
              type: "image",
              id: "old-title-context-image",
              name: "old-issue.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        delta: `content before retained tail${"x".repeat(8_100)}`,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context-complete"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate-truncated-context"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).toBe(
      `${firstUserContext}\n\n${truncationMarker}${retainedContext}`,
    );
    expect(harness.generateThreadTitle.mock.calls[0]?.[0].attachments).toEqual([
      expect.objectContaining({
        id: "old-title-context-image",
        name: "old-issue.png",
      }),
    ]);
  });

  it("does not overwrite a manual rename while title regeneration is running", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const generatedTitle = await harness.runEffect(
      Deferred.make<{ readonly title: string }, never>(),
    );
    harness.generateThreadTitle.mockReturnValue(Deferred.await(generatedTitle));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-regeneration-race"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    const pendingReadModel = await harness.readModel();
    expect(
      pendingReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.titleRegeneration?.requestId,
    ).toBe(CommandId.make("cmd-thread-title-regeneration-race"));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-during-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep manual rename",
      }),
    );
    await harness.runEffect(
      Deferred.succeed(generatedTitle, { title: "Generated title should not win" }),
    );
    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep manual rename");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite a manual rename while title regeneration is queued", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Generated title should not win" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-queued-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-before-regeneration-starts"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep queued manual rename",
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep queued manual rename");
  });

  it("skips superseded title regeneration before generation starts", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Latest regenerated title" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-superseded-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-latest-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Latest regenerated title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "workjet/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
    });
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan mode and the persisted command identity to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
      requestId: "command:cmd-turn-start-plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      requestId: "command:cmd-turn-start-unsupported-2",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  effectIt.effect(
    "rejects changing models after start when the provider requires a new thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-2"),
            role: "user",
            text: "second",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return (
              thread?.activities.some(
                (activity) => activity.kind === "provider.turn.start.failed",
              ) ?? false
            );
          }),
        );

        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const readModel = yield* Effect.promise(() => harness.readModel());
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
        ).toMatchObject({
          payload: {
            detail: expect.stringContaining(
              "cannot switch models after the conversation has started",
            ),
          },
        });
      }),
  );

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      resumeCursor: { opaque: "resume-1" },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("rejects cross-driver provider changes after the existing thread session has stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  effectIt.effect(
    "surfaces stale provider approval request failures without faking approval resolution",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() => createHarness());
        const now = "2026-01-01T00:00:00.000Z";
        harness.respondToRequest.mockImplementation(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "session/request_permission",
              detail: "Unknown pending permission request: approval-request-1",
            }),
          ),
        );

        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-for-approval-error"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-approval-requested"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-1",
              requestKind: "command",
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        });

        yield* harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make("cmd-approval-respond-stale"),
          threadId: ThreadId.make("thread-1"),
          requestId: asApprovalRequestId("approval-request-1"),
          decision: "acceptForSession",
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            if (!thread) return false;
            return thread.activities.some(
              (activity) => activity.kind === "provider.approval.respond.failed",
            );
          }),
        );

        const readModel = yield* Effect.promise(() => harness.readModel());
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(thread).toBeDefined();

        const failureActivity = thread?.activities.find(
          (activity) => activity.kind === "provider.approval.respond.failed",
        );
        expect(failureActivity).toBeDefined();
        expect(failureActivity?.payload).toMatchObject({
          requestId: "approval-request-1",
          detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
        });

        const resolvedActivity = thread?.activities.find(
          (activity) =>
            activity.kind === "approval.resolved" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
        );
        expect(resolvedActivity).toBeUndefined();
      }),
  );
  effectIt("surfaces non-resumable provider user-input callbacks as stale failures", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const now = "2026-01-01T00:00:00.000Z";
      harness.respondToUserInput.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: ProviderDriverKind.make("claudeAgent"),
            method: "item/tool/respondToUserInput",
            detail: "Unknown pending Codex user input request: user-input-request-1",
          }),
        ),
      );

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      });

      yield* harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
          if (!thread) return false;
          return thread.activities.some(
            (activity) => activity.kind === "provider.user-input.respond.failed",
          );
        }),
      );

      const readModel = yield* Effect.promise(() => harness.readModel());
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread).toBeDefined();

      const failureActivity = thread?.activities.find(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
      expect(failureActivity).toBeDefined();
      expect(failureActivity?.payload).toMatchObject({
        requestId: "user-input-request-1",
        detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
      });

      const resolvedActivity = thread?.activities.find(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
      );
      expect(resolvedActivity).toBeUndefined();
    }),
  );

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
  });
});
