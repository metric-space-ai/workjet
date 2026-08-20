import {
  type EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  type ServerLifecycleStreamReadyEvent,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createRuntimeCommand,
  scheduleAtomCommandEffect,
} from "./runtime.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import {
  isRpcClientError,
  request,
  runStream,
  subscribe,
  type EnvironmentRpcInput,
} from "../rpc/client.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export type ServerUpdateStage = "downloading" | "installing" | "resuming";

export const GREPPY_RUNTIME_INSPECT_STALE_TIME_MS = 15_000;

/**
 * The gateway status and catalog are cheap local reads whose value changes
 * whenever the operator starts, stops, or logs into the gateway, so keep the
 * freshness window short enough that a settings visit re-reads the host.
 */
export const WORKJET_GATEWAY_STATUS_STALE_TIME_MS = 5_000;
export const WORKJET_GATEWAY_CATALOG_STALE_TIME_MS = 5_000;
/**
 * Health is a live reading of the running host and the surface shows its age,
 * so it may go stale sooner than the configuration-derived catalog.
 */
export const WORKJET_GATEWAY_HEALTH_STALE_TIME_MS = 5_000;
/**
 * Model discovery answers from the host's compiled-in catalog plus the stored
 * account models; neither moves while the gateway runs, so this is cached for
 * far longer than the live reads.
 */
export const WORKJET_GATEWAY_MODELS_STALE_TIME_MS = 60_000;

/**
 * The mesh roster changes only when this machine exchanges mail with a peer it
 * has never heard from — a rare, durable event — so the composer may reuse a
 * recently read list instead of asking on every popover open.
 */
export const WORKJET_MESH_ROSTER_STALE_TIME_MS = 30_000;

/**
 * The multi-computer overview moves whenever an envelope or a delegation state
 * does, which is far more often than the pin table changes, so it gets a much
 * shorter freshness window than the roster. It is still a window, not a live
 * feed: the read reports LAST KNOWN contact, and nothing about it is a liveness
 * signal that a faster poll could make truer.
 */
export const WORKJET_MESH_OVERVIEW_STALE_TIME_MS = 5_000;

/**
 * How long a received-handoff listing stays fresh.
 *
 * Shorter than the roster's: a handoff is work somebody is waiting on, so the
 * inbox should notice an arrival within a few seconds — but it is still a poll,
 * not a subscription, and saying so here keeps the surface from implying a
 * liveness guarantee the mesh does not provide.
 */
export const WORKJET_HANDOFF_INBOX_STALE_TIME_MS = 10_000;

/**
 * How long a cross-mode link read stays fresh.
 *
 * A link is a durable, rarely changing fact — an object gets a Code thread once
 * and keeps it — so the Code thread's backlink read may reuse a recently read
 * answer instead of asking on every render. It is the same order as the roster
 * for the same reason: both answer "what is related to what", not "what is
 * happening now".
 */
export const WORKJET_CROSS_MODE_LINK_STALE_TIME_MS = 30_000;

/**
 * How long the legacy-import offer stays fresh.
 *
 * The longest window of the set, and deliberately so: the answer is a decision
 * about a file that is never rewritten, and it changes at most ONCE in this
 * environment's life — when the operator accepts or declines. The command that
 * causes that change refreshes the read itself, so nothing here has to poll for
 * it.
 */
export const WORKJET_LEGACY_IMPORT_STALE_TIME_MS = 300_000;

export type ServerUpdateState =
  | { readonly status: "idle" }
  | {
      readonly status: "running";
      readonly stage: ServerUpdateStage;
      readonly fromVersion: string;
      readonly targetVersion: string;
    }
  | {
      readonly status: "failed";
      readonly stage: ServerUpdateStage;
      readonly fromVersion: string;
      readonly targetVersion: string;
      readonly message: string;
    };

export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly input: EnvironmentRpcInput<typeof WS_METHODS.serverUpdateServer>;
}

const IDLE_SERVER_UPDATE_STATE: ServerUpdateState = { status: "idle" };
const EMPTY_SERVER_UPDATE_STATE_ATOM = Atom.make<ServerUpdateState>(IDLE_SERVER_UPDATE_STATE).pipe(
  Atom.withLabel("environment-data:server:update-state:empty"),
);
const serverUpdateStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<ServerUpdateState>(IDLE_SERVER_UPDATE_STATE).pipe(
    Atom.withLabel(`environment-data:server:update-state:${environmentId}`),
  ),
);

export class ServerUpdateResumeTimeoutError extends Schema.TaggedErrorClass<ServerUpdateResumeTimeoutError>()(
  "ServerUpdateResumeTimeoutError",
  {
    environmentId: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `The server did not resume on t3@${this.targetVersion}.`;
  }
}

export class ServerUpdateProgressIncompleteError extends Schema.TaggedErrorClass<ServerUpdateProgressIncompleteError>()(
  "ServerUpdateProgressIncompleteError",
  {
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `The t3@${this.targetVersion} update ended before the server accepted the restart.`;
  }
}

export class ServerUpdateTerminalError extends Schema.TaggedErrorClass<ServerUpdateTerminalError>()(
  "ServerUpdateTerminalError",
  {
    targetVersion: Schema.String,
    status: Schema.Literals(["committed", "rolled-back", "failed"]),
    reason: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason ?? `The t3@${this.targetVersion} update ${this.status}.`;
  }
}

// Covers the 120-second trial deadline and a final restart of the previous
// version when the trial rolls back.
const SERVER_UPDATE_RESUME_TIMEOUT = Duration.minutes(4);

export function matchesServerUpdateReadyEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): boolean {
  return result.updateId === undefined
    ? event.payload.environment.serverVersion === result.targetVersion
    : event.payload.updateOutcome?.id === result.updateId;
}

export function validateServerUpdateReadyEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): Effect.Effect<void, ServerUpdateTerminalError> {
  if (result.updateId === undefined) return Effect.void;
  const outcome = event.payload.updateOutcome;
  if (
    outcome?.id === result.updateId &&
    outcome.status === "committed" &&
    outcome.targetVersion === result.targetVersion &&
    event.payload.environment.serverVersion === result.targetVersion
  ) {
    return Effect.void;
  }
  return Effect.fail(
    new ServerUpdateTerminalError({
      targetVersion: result.targetVersion,
      status: outcome?.status ?? "failed",
      reason:
        outcome?.reason ??
        "The service launcher resumed without committing the requested server version.",
    }),
  );
}

/**
 * Keeps reconnect attempts ~1s apart for the whole update restart.
 *
 * A restart takes the server down for ~15 seconds, but the supervisor's normal
 * backoff ladder (1/2/4/8/16s) assumes an unexpected failure and lands attempts
 * at ~3, 5, 9, 17 and 33 seconds — so a 15-second restart is observed as a
 * 33-second "Resuming". Nudging on every backoff entry (not just the first)
 * holds the retry cadence flat until the server answers again. The sleep before
 * each nudge is the pacer: a connection that fails instantly re-enters backoff
 * immediately and would otherwise spin a tight retry loop.
 *
 * Callers fork this as a child of the update command so it is interrupted as
 * soon as the update settles, whether it succeeds, fails, or times out.
 */
export function nudgeReconnectDuringUpdateRestart(input: {
  readonly stateChanges: Stream.Stream<{ readonly phase: string }, unknown>;
  readonly retryNow: Effect.Effect<void>;
  readonly interval?: Duration.Duration;
}): Effect.Effect<void> {
  return input.stateChanges.pipe(
    Stream.filter((state) => state.phase === "backoff"),
    Stream.runForEach(() =>
      Effect.sleep(input.interval ?? Duration.seconds(1)).pipe(Effect.andThen(input.retryNow)),
    ),
    Effect.timeoutOption(SERVER_UPDATE_RESUME_TIMEOUT),
    Effect.ignore,
  );
}

export function serverUpdateStateForProgressEvent(
  fromVersion: string,
  targetVersion: string,
  event: ServerSelfUpdateProgressEvent,
): Extract<ServerUpdateState, { status: "running" }> {
  return {
    status: "running",
    stage: event.type === "complete" ? "resuming" : event.stage,
    fromVersion,
    targetVersion,
  };
}

export function serverUpdateStateForServerVersion(
  state: ServerUpdateState,
  serverVersion: string | null,
): ServerUpdateState {
  return state.status === "idle" ||
    state.status === "running" ||
    serverVersion === null ||
    state.fromVersion === serverVersion
    ? state
    : IDLE_SERVER_UPDATE_STATE;
}

function serverUpdateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

function isRpcSocketError(error: unknown): boolean {
  if (!isRpcClientError(error)) {
    return false;
  }
  switch (error.reason._tag) {
    case "SocketReadError":
    case "SocketWriteError":
    case "SocketCloseError":
      return true;
    default:
      return false;
  }
}

export function isLegacyUpdateHandoffLoss(cause: Cause.Cause<unknown>): boolean {
  if (Cause.hasInterruptsOnly(cause)) {
    return true;
  }
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every((reason) => Cause.isFailReason(reason) && isRpcSocketError(reason.error))
  );
}

export function resolveServerUpdateProgressResult<E>(
  targetVersion: string,
  terminal: Option.Option<ServerSelfUpdateResult>,
  streamExit: Exit.Exit<void, E>,
): Effect.Effect<ServerSelfUpdateResult, E | ServerUpdateProgressIncompleteError> {
  if (
    Option.isSome(terminal) &&
    (Exit.isSuccess(streamExit) || isLegacyUpdateHandoffLoss(streamExit.cause))
  ) {
    return Effect.succeed(terminal.value);
  }
  if (Exit.isFailure(streamExit)) {
    return Effect.failCause(streamExit.cause);
  }
  return Effect.fail(new ServerUpdateProgressIncompleteError({ targetVersion }));
}

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
  readonly source: "cache" | "live";
}

export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  switch (event.type) {
    case "snapshot":
      return Option.some({
        config: event.config,
        latestEvent: event,
        source: "live",
      });
    case "keybindingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          keybindings: event.payload.keybindings,
          issues: event.payload.issues,
        },
        latestEvent: event,
        source: "live",
      }));
    case "providerStatuses":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: event.payload.providers,
        },
        latestEvent: event,
        source: "live",
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          settings: event.payload.settings,
        },
        latestEvent: event,
        source: "live",
      }));
  }
}

export function projectServerConfig(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): readonly [Option.Option<ServerConfigProjection>, ReadonlyArray<ServerConfigProjection>] {
  const next = applyServerConfigProjection(current, event);
  return [next, Option.toArray(next)];
}

const cachedConfigSnapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

/**
 * Keeps a complete server configuration available during reconnects. Server
 * config carries the provider/model catalogue used by task creation, so it is
 * useful—and safe—to retain after a transport session ends.
 */
export const makeEnvironmentServerConfigState = Effect.fn("EnvironmentServerConfigState.make")(
  function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const cache = yield* EnvironmentCacheStore;
    const environmentId = supervisor.target.environmentId;
    const cachedConfig = yield* cache.loadServerConfig(environmentId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not load cached server configuration.").pipe(
          Effect.annotateLogs({
            environmentId,
            ...safeErrorLogAttributes(error),
          }),
          Effect.as(Option.none<ServerConfig>()),
        ),
      ),
    );
    const state = yield* SubscriptionRef.make<Option.Option<ServerConfigProjection>>(
      Option.map(cachedConfig, (config) => ({
        config,
        latestEvent: cachedConfigSnapshotEvent(config),
        source: "cache" as const,
      })),
    );
    const persistence = yield* Queue.sliding<ServerConfig>(1);
    const pendingPersistence = yield* Ref.make<Option.Option<ServerConfig>>(Option.none());

    const persist = Effect.fn("EnvironmentServerConfigState.persist")(function* (
      config: ServerConfig,
    ) {
      return yield* cache.saveServerConfig(environmentId, config).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist cached server configuration.").pipe(
            Effect.annotateLogs({
              environmentId,
              ...safeErrorLogAttributes(error),
            }),
            Effect.as(false),
          ),
        ),
      );
    });

    const persistPending = Effect.fn("EnvironmentServerConfigState.persistPending")(function* (
      config: ServerConfig,
    ) {
      if (!(yield* persist(config))) {
        return;
      }
      yield* Ref.update(pendingPersistence, (pending) =>
        Option.isSome(pending) && pending.value === config ? Option.none() : pending,
      );
    });

    yield* Stream.fromQueue(persistence).pipe(
      Stream.debounce("500 millis"),
      Stream.runForEach(persistPending),
      Effect.forkScoped,
    );

    yield* subscribe(WS_METHODS.subscribeServerConfig, {}).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const next = applyServerConfigProjection(yield* SubscriptionRef.get(state), event);
          if (Option.isNone(next)) {
            return;
          }
          yield* Ref.set(pendingPersistence, Option.some(next.value.config));
          yield* SubscriptionRef.set(state, next);
          yield* Queue.offer(persistence, next.value.config);
        }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      Ref.get(pendingPersistence).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (config) => persist(config).pipe(Effect.asVoid),
          }),
        ),
      ),
    );

    return state;
  },
);

export function serverConfigStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentServerConfigState().pipe(
        Effect.map((state) =>
          SubscriptionRef.changes(state).pipe(
            Stream.filterMap((projection) =>
              Option.match(projection, {
                onNone: () => Result.failVoid,
                onSome: (value) => Result.succeed(value),
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

export function projectServerWelcome(
  current: Option.Option<ServerLifecycleWelcomePayload>,
  event: {
    readonly type: "welcome" | "ready";
    readonly payload: unknown;
  },
): readonly [
  Option.Option<ServerLifecycleWelcomePayload>,
  ReadonlyArray<ServerLifecycleWelcomePayload>,
] {
  if (event.type !== "welcome") {
    return [current, []];
  }
  const welcome = event.payload as ServerLifecycleWelcomePayload;
  return [Option.some(welcome), [welcome]];
}

export function resolveServerConfigValue(
  projection: ServerConfigProjection | null,
  initialConfig: ServerConfig | null,
): ServerConfig | null {
  if (
    projection?.source === "live" &&
    (initialConfig === null ||
      projection.config.environment.serverVersion === initialConfig.environment.serverVersion)
  ) {
    return projection.config;
  }
  return initialConfig ?? projection?.config ?? null;
}

export function createServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
  options: {
    readonly initialConfigValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ServerConfig | null>;
  },
) {
  const configScheduler = createAtomCommandScheduler();
  // Updates stay serial end-to-end, but only their handoff phase occupies the config lane.
  const updateScheduler = createAtomCommandScheduler();
  const configConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const configProjectionFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(serverConfigStateChanges(environmentId))
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:config-projection:${environmentId}`),
      ),
  );
  const configProjection = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerConfig>;
  }) => configProjectionFamily(target.environmentId);
  const emptyConfigAtom = Atom.make<ServerConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:empty"),
  );
  const configValueAtom = Atom.family((environmentId: EnvironmentId | null) => {
    if (environmentId === null) {
      return emptyConfigAtom;
    }
    return Atom.make((get): ServerConfig | null => {
      const projection = Option.getOrNull(
        AsyncResult.value(get(configProjection({ environmentId, input: {} }))),
      );
      return resolveServerConfigValue(
        projection,
        get(options.initialConfigValueAtom(environmentId)),
      );
    }).pipe(Atom.withLabel(`environment-data:server:config:${environmentId}`));
  });
  const updateStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      serverUpdateStateForServerVersion(
        get(serverUpdateStateAtom(environmentId)),
        get(configValueAtom(environmentId))?.environment.serverVersion ?? null,
      ),
    ).pipe(Atom.withLabel(`environment-data:server:update-state-value:${environmentId}`)),
  );
  const updateStateAtom = (environmentId: EnvironmentId | null) =>
    environmentId === null ? EMPTY_SERVER_UPDATE_STATE_ATOM : updateStateValueAtom(environmentId);
  const updateServer = createRuntimeCommand<
    EnvironmentRegistry | EnvironmentCacheStore | R,
    E,
    ServerUpdateTarget,
    ServerSelfUpdateResult,
    unknown
  >(runtime, {
    label: "environment-data:server:update-server",
    scheduler: updateScheduler,
    concurrency: configConcurrency,
    execute: (target, atomRegistry) => {
      const stateAtom = serverUpdateStateAtom(target.environmentId);
      const targetVersion = target.input.targetVersion;
      let fromVersion =
        atomRegistry.get(configValueAtom(target.environmentId))?.environment.serverVersion ??
        targetVersion;
      let currentStage: ServerUpdateStage = "downloading";
      atomRegistry.set(stateAtom, {
        status: "running",
        stage: currentStage,
        fromVersion,
        targetVersion,
      });

      return Effect.gen(function* () {
        const environmentRegistry = yield* EnvironmentRegistry;
        const result = yield* scheduleAtomCommandEffect(
          atomRegistry,
          configScheduler,
          configConcurrency,
          target,
          Effect.gen(function* () {
            const currentConfig = atomRegistry.get(configValueAtom(target.environmentId));
            fromVersion = currentConfig?.environment.serverVersion ?? targetVersion;
            atomRegistry.set(stateAtom, {
              status: "running",
              stage: currentStage,
              fromVersion,
              targetVersion,
            });

            const supportsProgress =
              currentConfig?.environment.capabilities.serverSelfUpdateProgress === true;
            const updateResult: ServerSelfUpdateResult = supportsProgress
              ? yield* Effect.gen(function* () {
                  const terminal = yield* Ref.make<Option.Option<ServerSelfUpdateResult>>(
                    Option.none(),
                  );
                  const streamExit = yield* environmentRegistry
                    .runStream(
                      target.environmentId,
                      runStream(WS_METHODS.serverUpdateServerWithProgress, target.input),
                    )
                    .pipe(
                      Stream.runForEach((event) =>
                        Effect.sync(() => {
                          currentStage = event.type === "complete" ? "resuming" : event.stage;
                          atomRegistry.set(
                            stateAtom,
                            serverUpdateStateForProgressEvent(fromVersion, targetVersion, event),
                          );
                        }).pipe(
                          Effect.andThen(
                            event.type === "complete"
                              ? Ref.set(terminal, Option.some(event.result))
                              : Effect.void,
                          ),
                        ),
                      ),
                      Effect.exit,
                    );
                  return yield* resolveServerUpdateProgressResult(
                    targetVersion,
                    yield* Ref.get(terminal),
                    streamExit,
                  );
                })
              : yield* Effect.gen(function* () {
                  const selfUpdateMethod = currentConfig?.environment.capabilities.serverSelfUpdate;
                  const exit = yield* environmentRegistry
                    .run(target.environmentId, request(WS_METHODS.serverUpdateServer, target.input))
                    .pipe(Effect.exit);
                  if (Exit.isSuccess(exit)) {
                    return exit.value;
                  }
                  if (
                    (selfUpdateMethod === "boot-service" || selfUpdateMethod === "respawn") &&
                    isLegacyUpdateHandoffLoss(exit.cause)
                  ) {
                    // Older servers can tear down the transport before their
                    // unary acknowledgement arrives. Treat only that transport
                    // loss as a handoff, then prove it by waiting for target ready.
                    return { targetVersion, method: selfUpdateMethod };
                  }
                  return yield* Effect.failCause(exit.cause);
                });

            currentStage = "resuming";
            atomRegistry.set(stateAtom, {
              status: "running",
              stage: currentStage,
              fromVersion,
              targetVersion,
            });
            return updateResult;
          }),
        );

        // The update restart is intentional and the server stays unreachable
        // for the whole restart, so hold the retry cadence flat instead of
        // letting the supervisor climb its backoff ladder.
        yield* nudgeReconnectDuringUpdateRestart({
          stateChanges: environmentRegistry.stateChanges(target.environmentId),
          retryNow: environmentRegistry.retryNow(target.environmentId),
        }).pipe(Effect.forkChild);

        const resumed = yield* environmentRegistry
          .followStream(target.environmentId, subscribe(WS_METHODS.subscribeServerLifecycle, {}))
          .pipe(
            Stream.filter(
              (event): event is ServerLifecycleStreamReadyEvent =>
                event.type === "ready" && matchesServerUpdateReadyEvent(result, event),
            ),
            Stream.runHead,
            Effect.timeoutOption(SERVER_UPDATE_RESUME_TIMEOUT),
            Effect.map(Option.flatten),
          );
        if (Option.isNone(resumed)) {
          return yield* new ServerUpdateResumeTimeoutError({
            environmentId: target.environmentId,
            targetVersion,
          });
        }
        yield* validateServerUpdateReadyEvent(result, resumed.value);

        atomRegistry.set(stateAtom, IDLE_SERVER_UPDATE_STATE);
        return result;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              return;
            }
            if (Cause.hasInterruptsOnly(exit.cause)) {
              atomRegistry.set(stateAtom, IDLE_SERVER_UPDATE_STATE);
              return;
            }
            atomRegistry.set(stateAtom, {
              status: "failed",
              stage: currentStage,
              fromVersion,
              targetVersion,
              message: serverUpdateFailureMessage(Cause.squash(exit.cause)),
            });
          }),
        ),
      );
    },
  });
  const settingsValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.settings ?? null).pipe(
      Atom.withLabel(`environment-data:server:settings:${environmentId}`),
    ),
  );
  const providersValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.providers ?? null).pipe(
      Atom.withLabel(`environment-data:server:providers:${environmentId}`),
    ),
  );
  const greppyRuntimeInspect = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workjet:greppy:inspect",
    tag: WS_METHODS.workjetGreppyInspect,
    staleTimeMs: GREPPY_RUNTIME_INSPECT_STALE_TIME_MS,
  });
  const installGreppyRuntime = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:greppy:install",
    tag: WS_METHODS.workjetGreppyInstall,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId }) => environmentId,
    },
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => {
        registry.refresh(greppyRuntimeInspect({ environmentId, input: {} }));
      }),
  });

  const workjetGatewayStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workjet:gateway:status",
    tag: WS_METHODS.workjetGatewayStatus,
    staleTimeMs: WORKJET_GATEWAY_STATUS_STALE_TIME_MS,
  });
  const workjetGatewayCatalog = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workjet:gateway:catalog",
    tag: WS_METHODS.workjetGatewayCatalog,
    staleTimeMs: WORKJET_GATEWAY_CATALOG_STALE_TIME_MS,
  });
  const workjetGatewayHealth = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workjet:gateway:health",
    tag: WS_METHODS.workjetGatewayHealth,
    staleTimeMs: WORKJET_GATEWAY_HEALTH_STALE_TIME_MS,
  });
  const workjetGatewayModels = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workjet:gateway:models",
    tag: WS_METHODS.workjetGatewayDiscoverModels,
    staleTimeMs: WORKJET_GATEWAY_MODELS_STALE_TIME_MS,
  });
  // Every lifecycle and login transition changes the runtime phase, the
  // configured accounts, the health snapshot, and the model answer, so refresh
  // the set instead of a single read.
  const refreshWorkjetGateway = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(workjetGatewayStatus({ environmentId, input: {} }));
      registry.refresh(workjetGatewayCatalog({ environmentId, input: {} }));
      registry.refresh(workjetGatewayHealth({ environmentId, input: {} }));
      registry.refresh(workjetGatewayModels({ environmentId, input: {} }));
    });
  const workjetGatewayConcurrency = {
    mode: "singleFlight" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };
  const startWorkjetGateway = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:gateway:start",
    tag: WS_METHODS.workjetGatewayStart,
    concurrency: workjetGatewayConcurrency,
    onSuccess: refreshWorkjetGateway,
  });
  const stopWorkjetGateway = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:gateway:stop",
    tag: WS_METHODS.workjetGatewayStop,
    concurrency: workjetGatewayConcurrency,
    onSuccess: refreshWorkjetGateway,
  });
  // The user completes the provider login in their own browser; the client only
  // starts the session, polls its opaque handle, and cancels it.
  const startWorkjetGatewayOauth = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:gateway:oauth-start",
    tag: WS_METHODS.workjetGatewayOauthStart,
    concurrency: workjetGatewayConcurrency,
  });
  const pollWorkjetGatewayOauth = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:gateway:oauth-poll",
    tag: WS_METHODS.workjetGatewayOauthPoll,
    concurrency: workjetGatewayConcurrency,
  });
  const cancelWorkjetGatewayOauth = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:gateway:oauth-cancel",
    tag: WS_METHODS.workjetGatewayOauthCancel,
    concurrency: workjetGatewayConcurrency,
    onSuccess: refreshWorkjetGateway,
  });
  // The one command whose payload carries a credential. It travels over the
  // same authenticated socket as every other gateway command and is never
  // retained by the client: the caller drops the input after dispatching.
  const addWorkjetGatewayApiKeyAccount = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:gateway:add-api-key-account",
    tag: WS_METHODS.workjetGatewayAddApiKeyAccount,
    concurrency: workjetGatewayConcurrency,
    onSuccess: refreshWorkjetGateway,
  });
  // Pool editing rewrites the configuration and reloads the host, so it shares
  // the gateway's single-flight key with every other lifecycle command.
  const updateWorkjetGatewayRouting = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:gateway:update-routing",
    tag: WS_METHODS.workjetGatewayUpdateRouting,
    concurrency: workjetGatewayConcurrency,
    onSuccess: refreshWorkjetGateway,
  });

  // The one-shot legacy Swift configuration import.
  //
  // A read and a terminal write, both keyed per ENVIRONMENT because that is
  // what the decision is about: the legacy document lives on the machine each
  // server runs on, and the import lands in that server's own settings.
  const workjetLegacyImport = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workjet:legacy-import:inspect",
    tag: WS_METHODS.workjetLegacyImportInspect,
    staleTimeMs: WORKJET_LEGACY_IMPORT_STALE_TIME_MS,
  });
  // Answering the offer patches `settings.workjet` and records a TERMINAL
  // marker, so it is single-flighted per environment — two concurrent answers
  // are exactly the race the server refuses. On success only the OFFER is
  // refreshed, because it is now a recorded decision; the patched settings
  // arrive on their own through the server's config stream, exactly as they do
  // for every other settings write.
  const decideWorkjetLegacyImport = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:legacy-import:decide",
    tag: WS_METHODS.workjetLegacyImportDecide,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId }) => environmentId,
    },
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => {
        registry.refresh(workjetLegacyImport({ environmentId, input: {} }));
      }),
  });

  // The recipient roster the composer picks from: a bounded, redacted read of
  // the peers this machine has already exchanged mail with. It is a read, not a
  // send, so it is a query atom family beside the gateway reads rather than one
  // of the thread-scoped mailbox commands below.
  const workjetMeshRoster = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workjet:mesh:roster",
    tag: WS_METHODS.workjetMeshRoster,
    staleTimeMs: WORKJET_MESH_ROSTER_STALE_TIME_MS,
  });

  // The global multi-computer activity overview. Same shape of read as the
  // roster — bounded, redacted, no key material — one step wider: last-known
  // envelope contact and delegation counts per peer machine.
  const workjetMeshOverview = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workjet:mesh:overview",
    tag: WS_METHODS.workjetMeshOverview,
    staleTimeMs: WORKJET_MESH_OVERVIEW_STALE_TIME_MS,
  });

  // Sending into another worker's mailbox is single-flighted per SOURCE THREAD,
  // not per environment: two orchestrator threads on one server are two
  // independent conversations, and a slow send from one must not swallow the
  // other's. Nothing is refreshed on success — the durable trace arrives as a
  // thread activity through the ordinary thread subscription, so an optimistic
  // refresh here would only race it.
  const workjetMailboxConcurrency = {
    mode: "singleFlight" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly sourceThreadId: string };
    }) => `${environmentId}:${input.sourceThreadId}`,
  };
  const sendWorkjetMailboxMessage = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:mailbox:send-message",
    tag: WS_METHODS.workjetMailboxSendMessage,
    concurrency: workjetMailboxConcurrency,
  });
  const delegateWorkjetMailboxTask = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:mailbox:delegate-task",
    tag: WS_METHODS.workjetMailboxDelegateTask,
    concurrency: workjetMailboxConcurrency,
  });
  // The thread-action operations (reply / request review / update delegation)
  // are single-flighted per SOURCE THREAD exactly like send: they originate
  // from the same orchestrator thread and the durable state/receipt returns
  // through the ordinary thread subscription, so no optimistic refresh here.
  const replyWorkjetMailbox = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:mailbox:reply",
    tag: WS_METHODS.workjetMailboxReply,
    concurrency: workjetMailboxConcurrency,
  });
  const requestReviewWorkjetMailbox = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:mailbox:request-review",
    tag: WS_METHODS.workjetMailboxRequestReview,
    concurrency: workjetMailboxConcurrency,
  });
  const updateDelegationWorkjetMailbox = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:mailbox:update-delegation",
    tag: WS_METHODS.workjetMailboxUpdateDelegation,
    concurrency: workjetMailboxConcurrency,
  });
  // Reassignment is the same class of thread-scoped write, so it shares the
  // per-source-thread single flight: the durable re-render carries the new
  // target back through the ordinary thread subscription.
  const reassignDelegationWorkjetMailbox = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:mailbox:reassign-delegation",
    tag: WS_METHODS.workjetMailboxReassignDelegation,
    concurrency: workjetMailboxConcurrency,
  });
  // A handoff is sent FROM a thread, so it shares the per-source-thread single
  // flight with every other thread-scoped write.
  const sendHandoffWorkjetMailbox = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:mailbox:send-handoff",
    tag: WS_METHODS.workjetMailboxSendHandoff,
    concurrency: workjetMailboxConcurrency,
  });
  // The received-handoff inbox: a bounded, redacted READ, so it is a query atom
  // family beside the roster rather than one of the writes above.
  const workjetMailboxHandoffs = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workjet:mailbox:handoffs",
    tag: WS_METHODS.workjetMailboxListHandoffs,
    staleTimeMs: WORKJET_HANDOFF_INBOX_STALE_TIME_MS,
  });
  // Accepting is single-flighted per ENVIRONMENT, not per source thread: the
  // input names no source thread — it continues work that arrived from another
  // machine — and two concurrent accepts on one server are exactly the race the
  // server refuses. Serialising them here means the operator sees one honest
  // refusal instead of a second thread being created and deleted. On success the
  // inbox is refreshed, because the row's acceptance link changed and the
  // listing is polled, not pushed.
  const acceptHandoffWorkjetMailbox = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:mailbox:accept-handoff",
    tag: WS_METHODS.workjetMailboxAcceptHandoff,
    concurrency: workjetGatewayConcurrency,
    onSuccess: (
      { environmentId }: { readonly environmentId: EnvironmentId },
      registry: AtomRegistry.AtomRegistry,
    ) =>
      Effect.sync(() => {
        registry.refresh(workjetMailboxHandoffs({ environmentId, input: {} }));
      }),
  });

  // The cross-mode workflow bridge.
  //
  // The Code thread's BACKLINK read is keyed per thread, so a thread that
  // carries no link keeps its own cached "no link" answer instead of sharing one
  // with every other thread.
  const workjetCrossModeThreadLink = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workjet:crossmode:thread-link",
    tag: WS_METHODS.workjetCrossModeGetThreadLink,
    staleTimeMs: WORKJET_CROSS_MODE_LINK_STALE_TIME_MS,
  });
  const workjetCrossModeLinks = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workjet:crossmode:links",
    tag: WS_METHODS.workjetCrossModeListLinks,
    staleTimeMs: WORKJET_CROSS_MODE_LINK_STALE_TIME_MS,
  });
  // `Delegate to Code` / `Open in Code` is single-flighted per ENVIRONMENT
  // rather than per source thread: its input names a HOST thread, not a source,
  // and the race that matters is two clicks on the same Business OS OBJECT — a
  // race the server resolves by selecting rather than forking. Serialising per
  // environment means the operator sees one answer instead of a thread being
  // created and immediately deleted.
  const openWorkjetCrossModeInCode = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:crossmode:open-in-code",
    tag: WS_METHODS.workjetCrossModeOpenInCode,
    concurrency: workjetGatewayConcurrency,
  });
  // A return is made FROM the link's own Code thread, so it shares the
  // per-source-thread single flight the other thread-scoped writes use — keyed
  // on `threadId`, which is what this input calls its source.
  const submitWorkjetCrossMode = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:workjet:crossmode:submit",
    tag: WS_METHODS.workjetCrossModeSubmit,
    concurrency: {
      mode: "singleFlight" as const,
      key: ({
        environmentId,
        input,
      }: {
        readonly environmentId: EnvironmentId;
        readonly input: { readonly threadId: string };
      }) => `${environmentId}:${input.threadId}`,
    },
  });

  return {
    configValueAtom,
    updateStateAtom,
    workjetCrossModeThreadLink,
    workjetCrossModeLinks,
    openWorkjetCrossModeInCode,
    submitWorkjetCrossMode,
    sendWorkjetMailboxMessage,
    delegateWorkjetMailboxTask,
    replyWorkjetMailbox,
    requestReviewWorkjetMailbox,
    updateDelegationWorkjetMailbox,
    reassignDelegationWorkjetMailbox,
    sendHandoffWorkjetMailbox,
    acceptHandoffWorkjetMailbox,
    workjetMailboxHandoffs,
    workjetMeshRoster,
    workjetMeshOverview,
    workjetGatewayStatus,
    workjetGatewayCatalog,
    workjetGatewayHealth,
    workjetGatewayModels,
    startWorkjetGateway,
    stopWorkjetGateway,
    startWorkjetGatewayOauth,
    pollWorkjetGatewayOauth,
    cancelWorkjetGatewayOauth,
    addWorkjetGatewayApiKeyAccount,
    updateWorkjetGatewayRouting,
    workjetLegacyImport,
    decideWorkjetLegacyImport,
    settingsValueAtom,
    providersValueAtom,
    traceDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:trace-diagnostics",
      tag: WS_METHODS.serverGetTraceDiagnostics,
    }),
    processDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-diagnostics",
      tag: WS_METHODS.serverGetProcessDiagnostics,
    }),
    processResourceHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-resource-history",
      tag: WS_METHODS.serverGetProcessResourceHistory,
    }),
    resourceTelemetry: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry",
      tag: WS_METHODS.subscribeResourceTelemetry,
      idleTtlMs: 0,
    }),
    // The bounded, redacted Workjet mailbox audit/observability event stream.
    // A later slice renders it (toasts / an activity surface); this wires the
    // consumable subscription.
    workjetMailboxAuditEvents: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:workjet-mailbox-audit",
      tag: WS_METHODS.subscribeWorkjetMailboxAudit,
    }),
    resourceTelemetryHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry-history",
      tag: WS_METHODS.serverGetResourceTelemetryHistory,
      staleTimeMs: 5_000,
    }),
    // A cold transcript scan is measured in seconds, so keep the result around
    // long enough that switching windows or re-rendering does not rescan.
    usageSummary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:usage-summary",
      tag: WS_METHODS.serverGetUsageSummary,
      staleTimeMs: 60_000,
    }),
    greppyRuntimeInspect,
    installGreppyRuntime,
    configProjection,
    welcome: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:welcome",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(Option.none<ServerLifecycleWelcomePayload>, projectServerWelcome),
        ),
    }),
    refreshProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-providers",
      tag: WS_METHODS.serverRefreshProviders,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    updateProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-provider",
      tag: WS_METHODS.serverUpdateProvider,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateServer,
    upsertKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:upsert-keybinding",
      tag: WS_METHODS.serverUpsertKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    removeKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-keybinding",
      tag: WS_METHODS.serverRemoveKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-settings",
      tag: WS_METHODS.serverUpdateSettings,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    signalProcess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:signal-process",
      tag: WS_METHODS.serverSignalProcess,
    }),
    retryResourceTelemetry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:retry-resource-telemetry",
      tag: WS_METHODS.serverRetryResourceTelemetry,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
