import { execFile } from "node:child_process";
import { EnvironmentId, AuthSessionId, TrimmedNonEmptyString } from "@workjet/contracts";
import { resolveRemoteWebSocketConnectionUrl } from "@workjet/client-runtime/authorization";
import { PrimaryConnectionTarget } from "@workjet/client-runtime/connection";
import { RpcSessionFactory } from "@workjet/client-runtime/rpc";
import { isLocalServiceOrigin, LocalServiceTarget } from "@workjet/shared/localServiceTarget";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { DesktopBackendStartConfig } from "./DesktopBackendManager.ts";
import * as Credential from "./DesktopLocalServiceCredential.ts";

export class LocalServiceSessionError extends Schema.TaggedErrorClass<LocalServiceSessionError>()(
  "LocalServiceSessionError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `Could not ${this.operation} the saved local Desktop session. No replacement session was authorized.`;
  }
}

const IssuedSession = Schema.Struct({
  sessionId: AuthSessionId,
  token: Schema.RedactedFromValue(TrimmedNonEmptyString),
  expiresAt: TrimmedNonEmptyString,
});
type Store = Effect.Success<ReturnType<typeof Credential.make>>;
export interface LocalSessionDependencies {
  readonly discover: (
    config: DesktopBackendStartConfig,
  ) => Effect.Effect<LocalServiceTarget, LocalServiceSessionError>;
  readonly openStore: (
    target: LocalServiceTarget,
  ) => Effect.Effect<Store, LocalServiceSessionError>;
  readonly issue: (
    config: DesktopBackendStartConfig,
    target: LocalServiceTarget,
  ) => Effect.Effect<typeof IssuedSession.Type, LocalServiceSessionError>;
  readonly revoke: (
    config: DesktopBackendStartConfig,
    target: LocalServiceTarget,
    sessionId: string,
  ) => Effect.Effect<void, LocalServiceSessionError>;
  readonly validate: (
    target: LocalServiceTarget,
    credential: Credential.LocalServiceCredential,
  ) => Effect.Effect<void, LocalServiceSessionError>;
}

const fail = (operation: string) => new LocalServiceSessionError({ operation });

/** One main-owned store and enrollment lock, shared by all windows and callers. */
export const makeSessionAccess = Effect.fn("desktop.localServiceSession.access")(function* (
  dependencies: LocalSessionDependencies,
) {
  const lock = yield* Semaphore.make(1);
  const stores = new Map<string, Store>();
  const uncertainEnrollments = new Set<string>();
  const get = (config: DesktopBackendStartConfig) =>
    lock.withPermit(
      Effect.gen(function* () {
        const target = yield* dependencies.discover(config);
        if (uncertainEnrollments.has(target.baseDir))
          return yield* fail("resolve the previous incomplete enrollment for");
        let store = stores.get(target.baseDir);
        if (store === undefined) {
          store = yield* dependencies.openStore(target);
          stores.set(target.baseDir, store);
        }
        const saved = yield* store.get.pipe(Effect.mapError(() => fail("read or unlock")));
        const now = yield* Clock.currentTimeMillis;
        if (Option.isSome(saved)) {
          if (
            saved.value.environmentId !== target.environmentId ||
            saved.value.baseDir !== target.baseDir
          )
            return yield* fail("verify the profile binding of");
          if (Date.parse(saved.value.expiresAt) <= now)
            return yield* fail("reuse an expired credential for");
          // A revoked token, changed identity or transport failure must not become
          // silent re-enrollment. Every request verifies the current generation.
          yield* dependencies.validate(target, saved.value);
          return Redacted.value(saved.value.token);
        }
        yield* store.requireProtection.pipe(Effect.mapError(() => fail("protect")));
        const credentialStore = store;
        // Issue/revoke cannot be interrupted halfway through. Saving and validation
        // remain interruptible and bounded, including a pending OS keychain dialog.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const issued = yield* dependencies.issue(config, target);
            const credential: Credential.LocalServiceCredential = {
              version: 1,
              baseDir: target.baseDir,
              environmentId: target.environmentId,
              ...issued,
            };
            const persist = Effect.gen(function* () {
              if (
                !Number.isFinite(Date.parse(issued.expiresAt)) ||
                Date.parse(issued.expiresAt) <= now
              )
                return yield* fail("validate the expiry of");
              yield* dependencies.validate(target, credential);
              yield* credentialStore.save(credential).pipe(Effect.mapError(() => fail("save")));
              return Redacted.value(credential.token);
            });
            const result = yield* Effect.exit(
              persist.pipe(Effect.timeout("30 seconds"), Effect.interruptible),
            );
            if (Exit.isSuccess(result)) return result.value;
            yield* dependencies
              .revoke(config, target, issued.sessionId)
              .pipe(
                Effect.catch(() =>
                  Effect.sync(() => uncertainEnrollments.add(target.baseDir)).pipe(
                    Effect.andThen(
                      Effect.fail(
                        fail(
                          "revoke the newly issued credential after failing to save or validate",
                        ),
                      ),
                    ),
                  ),
                ),
              );
            return yield* fail("save or validate");
          }),
        );
      }),
    );
  return { get };
});

/** Captures CLI stdout only in memory. Neither command arguments nor diagnostics contain bearer tokens. */
const runCli = (config: DesktopBackendStartConfig, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          config.executablePath,
          [config.entryPath, ...args],
          {
            cwd: config.cwd,
            env: config.extendEnv ? { ...process.env, ...config.env } : config.env,
            encoding: "utf8",
            timeout: 30_000,
            killSignal: "SIGKILL",
            maxBuffer: 64 * 1024,
            signal,
          },
          (error, stdout) =>
            error ? reject(fail("run the local authorization command for")) : resolve(stdout),
        );
      }),
    catch: () => fail("run the local authorization command for"),
  });
const identityArgs = (target: LocalServiceTarget) => [
  "--base-dir",
  target.baseDir,
  "--local-environment-id",
  target.environmentId,
  "--local-runtime-instance-id",
  target.runtimeInstanceId,
];

export class DesktopLocalServiceSession extends Context.Service<
  DesktopLocalServiceSession,
  {
    readonly get: (
      config: DesktopBackendStartConfig,
    ) => Effect.Effect<string, LocalServiceSessionError>;
  }
>()("@workjet/desktop/backend/DesktopLocalServiceSession") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const rpc = yield* RpcSessionFactory;
  const storeContext = yield* Effect.context<Effect.Services<ReturnType<typeof Credential.make>>>();
  return yield* makeSessionAccess({
    discover: (config) =>
      Effect.gen(function* () {
        if (config.localSession === undefined || !isLocalServiceOrigin(config.httpBaseUrl.href))
          return yield* fail("resolve");
        const baseDir = yield* fs
          .realPath(config.localSession.baseDir)
          .pipe(Effect.mapError(() => fail("resolve the profile for")));
        const target = yield* runCli(config, ["__desktop-target", "--base-dir", baseDir]).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LocalServiceTarget))),
          Effect.mapError(() => fail("discover")),
        );
        if (
          target.baseDir !== baseDir ||
          target.serverVersion !== config.localSession.serverVersion ||
          !isLocalServiceOrigin(target.origin) ||
          new URL(target.origin).origin !== config.httpBaseUrl.origin
        )
          return yield* fail("verify the endpoint of");
        return target;
      }),
    openStore: (target) =>
      Credential.make(target).pipe(
        Effect.provide(storeContext),
        Effect.mapError(() => fail("open the protected store for")),
      ),
    issue: (config, target) =>
      runCli(config, [
        "auth",
        "session",
        "issue",
        ...identityArgs(target),
        "--label",
        "Workjet Desktop",
        "--json",
      ]).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(IssuedSession))),
        Effect.mapError(() => fail("enroll")),
      ),
    revoke: (config, target, sessionId) =>
      runCli(config, ["auth", "session", "revoke", sessionId, ...identityArgs(target)]).pipe(
        Effect.asVoid,
      ),
    validate: (target, credential) =>
      Effect.scoped(
        Effect.gen(function* () {
          const wsBaseUrl = target.origin.replace(/^http:/, "ws:");
          const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
            httpBaseUrl: target.origin,
            wsBaseUrl,
            bearerToken: Redacted.value(credential.token),
          });
          const connectionTarget = new PrimaryConnectionTarget({
            environmentId: EnvironmentId.make(target.environmentId),
            label: "Workjet Desktop",
            httpBaseUrl: target.origin,
            wsBaseUrl,
          });
          const session = yield* rpc.connect({
            ...connectionTarget,
            runtimeInstanceId: target.runtimeInstanceId,
            socketUrl,
            httpAuthorization: null,
            target: connectionTarget,
          });
          yield* session.ready;
          if ((yield* session.initialConfig).environment.serverVersion !== target.serverVersion)
            return yield* fail("verify the server version for");
        }),
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.timeout("20 seconds"),
        Effect.mapError(() => fail("authenticate the current server generation for")),
      ),
  });
});
export const layer = Layer.effect(DesktopLocalServiceSession, make);
