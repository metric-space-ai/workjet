import {
  RemoteWorkerDispatchError,
  type NativeSupervisorSource,
  type NativeSupervisorSourceRegistration,
  type NativeSupervisorWorkerIntent,
  type NativeSupervisorWorkerCompletion,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import type { RemoteWorkerNativeScope } from "./ctox/CtoxRemoteWorkerAdmission.ts";

export interface NativeSupervisorWorkerSource {
  readonly source: NativeSupervisorSource;
  readonly scope: RemoteWorkerNativeScope;
}
export interface RegisteredNativeWorkerSource {
  readonly source: NativeSupervisorWorkerSource;
  readonly registration: NativeSupervisorSourceRegistration;
}
interface Dependencies {
  readonly now?: Effect.Effect<number>;
  readonly reportOutcomes?: (
    sources: ReadonlyArray<RegisteredNativeWorkerSource>,
  ) => Effect.Effect<void, RemoteWorkerDispatchError>;
  readonly sources: Effect.Effect<
    ReadonlyArray<NativeSupervisorWorkerSource>,
    RemoteWorkerDispatchError
  >;
  readonly currentSource: (
    intent: NativeSupervisorWorkerIntent,
  ) => Effect.Effect<NativeSupervisorWorkerSource, RemoteWorkerDispatchError>;
  readonly register: (
    source: NativeSupervisorWorkerSource,
  ) => Effect.Effect<NativeSupervisorSourceRegistration, RemoteWorkerDispatchError>;
  readonly poll: (
    scope: RemoteWorkerNativeScope,
  ) => Effect.Effect<ReadonlyArray<NativeSupervisorWorkerIntent>, RemoteWorkerDispatchError>;
  readonly dispatch: (
    source: NativeSupervisorWorkerSource,
    intent: NativeSupervisorWorkerIntent,
  ) => Effect.Effect<Option.Option<NativeSupervisorWorkerCompletion>, RemoteWorkerDispatchError>;
  readonly complete: (
    scope: RemoteWorkerNativeScope,
    registration: NativeSupervisorSourceRegistration,
    intent: NativeSupervisorWorkerIntent,
    result: NativeSupervisorWorkerCompletion,
  ) => Effect.Effect<void, RemoteWorkerDispatchError>;
}
const key = (value: NativeSupervisorWorkerSource) =>
  `${value.scope.connectionId}/${value.scope.instanceId}/${value.source.sourceEnvironmentId}/${value.source.sourceSupervisorThreadId}/${value.source.projectId}`;
const sameSource = (source: NativeSupervisorWorkerSource, intent: NativeSupervisorWorkerIntent) =>
  source.source.sourceEnvironmentId === intent.sourceEnvironmentId &&
  source.source.sourceSupervisorThreadId === intent.sourceSupervisorThreadId &&
  source.source.projectId === intent.projectId;
const scopeKey = (scope: RemoteWorkerNativeScope) => `${scope.connectionId}/${scope.instanceId}`;
const SOURCE_RETRY_MS = 60_000;
const failure = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });

/** One bounded source loop. Native owns the intent queue, Workjet owns its
 * existing dispatch; neither a renderer lifetime nor a new executor is involved. */
export function makeNativeSupervisorWorkerDispatch(dependencies: Dependencies) {
  const registered = new Map<string, NativeSupervisorSourceRegistration>();
  const registrationRetryAfter = new Map<string, number>();
  const pollRetryAfter = new Map<string, number>();
  const runCycle = Effect.gen(function* () {
    const now = yield* dependencies.now ?? Clock.currentTimeMillis;
    const sources = yield* dependencies.sources;
    if (sources.length > 32) return yield* failure();
    const liveScopes = new Set(sources.map(({ scope }) => scopeKey(scope)));
    for (const saved of pollRetryAfter.keys())
      if (!liveScopes.has(saved)) pollRetryAfter.delete(saved);
    const live = new Set(sources.map(key));
    for (const saved of registered.keys()) if (!live.has(saved)) registered.delete(saved);
    for (const saved of registrationRetryAfter.keys())
      if (!live.has(saved)) registrationRetryAfter.delete(saved);
    for (const source of sources) {
      if (registered.has(key(source)) || (registrationRetryAfter.get(key(source)) ?? 0) > now)
        continue;
      yield* dependencies.register(source).pipe(
        Effect.tap((receipt) =>
          Effect.sync(() => {
            registered.set(key(source), receipt);
            registrationRetryAfter.delete(key(source));
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => registrationRetryAfter.set(key(source), now + SOURCE_RETRY_MS)),
        ),
        Effect.ignore,
      );
    }
    const scopes = new Map<string, RemoteWorkerNativeScope>();
    for (const source of sources)
      if (registered.has(key(source))) scopes.set(scopeKey(source.scope), source.scope);
    for (const scope of scopes.values()) {
      if ((pollRetryAfter.get(scopeKey(scope)) ?? 0) > now) continue;
      yield* Effect.gen(function* () {
        const intents = yield* dependencies
          .poll(scope)
          .pipe(
            Effect.tapError(() =>
              Effect.sync(() => pollRetryAfter.set(scopeKey(scope), now + SOURCE_RETRY_MS)),
            ),
          );
        if (intents.length > 1) return yield* failure();
        for (const intent of intents) {
          // Re-read the actual local orchestrator and live native binding after
          // the await. Caller/agent parent IDs never create invocation authority.
          const current = yield* dependencies.currentSource(intent);
          if (
            !sameSource(current, intent) ||
            current.scope.connectionId !== scope.connectionId ||
            current.scope.instanceId !== scope.instanceId
          )
            return yield* failure();
          const registration = registered.get(key(current));
          if (
            !registration ||
            registration.registrationId !== intent.registrationId ||
            registration.revision !== intent.registrationRevision
          )
            return yield* failure();
          const result = yield* dependencies.dispatch(current, intent);
          if (Option.isSome(result))
            yield* dependencies.complete(scope, registration, intent, result.value);
        }
      }).pipe(Effect.ignore);
    }
    if (dependencies.reportOutcomes) {
      const current = sources.flatMap((source) => {
        const registration = registered.get(key(source));
        return registration === undefined || (pollRetryAfter.get(scopeKey(source.scope)) ?? 0) > now
          ? []
          : [{ source, registration }];
      });
      yield* dependencies.reportOutcomes(current).pipe(Effect.ignore);
    }
  });
  return { runCycle };
}
