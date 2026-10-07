import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import {
  EnvironmentId,
  AuthSessionId,
  TrimmedNonEmptyString,
  EnvironmentInternalError,
} from "@workjet/contracts";
import {
  resolveRemoteWebSocketConnectionUrl,
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthTimeoutError,
  RemoteEnvironmentAuthUndeclaredStatusError,
} from "@workjet/client-runtime/authorization";
import {
  PrimaryConnectionTarget,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "@workjet/client-runtime/connection";
import { RpcSessionFactory, type RpcSession } from "@workjet/client-runtime/rpc";
import { isLocalServiceOrigin, LocalServiceTarget } from "@workjet/shared/localServiceTarget";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { DesktopBackendStartConfig } from "./DesktopBackendManager.ts";
import * as Credential from "./DesktopLocalServiceCredential.ts";
import { ElectronDialog } from "../electron/ElectronDialog.ts";

const LocalCliCommandFailure = Schema.Struct({
  command: Schema.Literals([
    "service-install",
    "service-status",
    "service-start",
    "service-other",
    "service-discovery",
    "authorization",
  ]),
  kind: Schema.Literals(["spawn", "read", "output-limit", "exit", "timeout"]),
  exitCode: Schema.optionalKey(Schema.Number),
  step: Schema.optionalKey(
    Schema.Literals(["bundle-staging", "runtime-verification", "service-start"]),
  ),
});
type LocalCliCommandFailure = typeof LocalCliCommandFailure.Type;

export class LocalServiceSessionError extends Schema.TaggedErrorClass<LocalServiceSessionError>()(
  "LocalServiceSessionError",
  {
    operation: Schema.String,
    recoveryAttempted: Schema.optionalKey(Schema.Boolean),
    retryable: Schema.optionalKey(Schema.Boolean),
    commandFailure: Schema.optionalKey(LocalCliCommandFailure),
  },
) {
  override get message(): string {
    const failure = this.commandFailure;
    const discoveryDetail =
      failure?.command !== "service-discovery"
        ? ""
        : failure.kind === "exit"
          ? ` Local service discovery exited with code ${failure.exitCode ?? "unknown"}.`
          : {
              timeout: " Local service discovery timed out.",
              spawn: " Local service discovery could not start.",
              read: " Local service discovery output could not be read.",
              "output-limit": " Local service discovery returned too much output.",
            }[failure.kind];
    return `Could not ${this.operation} the saved local Desktop session.${discoveryDetail} No replacement session was authorized.`;
  }
}

const IssuedSession = Schema.Struct({
  sessionId: AuthSessionId,
  token: Schema.RedactedFromValue(TrimmedNonEmptyString),
  expiresAt: TrimmedNonEmptyString,
});
type Store = Effect.Success<ReturnType<typeof Credential.make>>;
export interface LocalSessionDependencies {
  readonly confirmRecovery: (
    target: LocalServiceTarget,
  ) => Effect.Effect<boolean, LocalServiceSessionError>;
  readonly listEnrollmentSessions: (
    config: DesktopBackendStartConfig,
    target: LocalServiceTarget,
    attemptId: string,
  ) => Effect.Effect<ReadonlyArray<string>, LocalServiceSessionError>;
  readonly discover: (
    config: DesktopBackendStartConfig,
  ) => Effect.Effect<LocalServiceTarget, LocalServiceSessionError>;
  readonly openStore: (
    target: LocalServiceTarget,
  ) => Effect.Effect<Store, LocalServiceSessionError>;
  readonly issue: (
    config: DesktopBackendStartConfig,
    target: LocalServiceTarget,
    enrollmentId: string,
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
const retry = (operation: string) => new LocalServiceSessionError({ operation, retryable: true });
const classifySessionRpcError = (error: ConnectionAttemptError): LocalServiceSessionError =>
  Schema.is(ConnectionTransientError)(error)
    ? retry("connect to")
    : fail("authenticate the current server generation for");

export const classifySessionConnectionFailure = (
  error: LocalServiceSessionError | Cause.TimeoutError,
): LocalServiceSessionError =>
  Schema.is(LocalServiceSessionError)(error)
    ? error
    : Cause.isTimeoutError(error)
      ? retry("reach")
      : fail("authenticate the current server generation for");

/** Keep bounded CLI diagnostics; a discovery timeout does not invalidate a credential. */
export const classifyLocalServiceDiscoveryFailure = (error: unknown): LocalServiceSessionError => {
  const commandFailure = Schema.is(LocalServiceSessionError)(error)
    ? error.commandFailure
    : undefined;
  return new LocalServiceSessionError({
    operation: "discover",
    ...(commandFailure === undefined ? {} : { commandFailure }),
    ...(commandFailure?.kind === "timeout" ? { retryable: true } : {}),
  });
};

export const requestLocalSessionRecoveryConsent = (
  dialog: Pick<typeof ElectronDialog.Service, "showMessageBox">,
  target: Pick<LocalServiceTarget, "baseDir">,
) =>
  dialog
    .showMessageBox({
      type: "question",
      title: "Reconnect Workjet Desktop",
      message: "Restore this app's connection to its local background service?",
      detail: `Close other Workjet installations using this profile first. Workjet will revoke this installation's previous session and preserve its old encrypted credentials before reconnecting. Your projects and running work stay in place.\n\nProfile: ${target.baseDir}`,
      buttons: ["Cancel", "Restore connection"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      checkboxLabel: "Other Workjet installations using this profile are closed.",
      checkboxChecked: false,
    })
    .pipe(
      Effect.map((result) => result.response === 1 && result.checkboxChecked),
      Effect.mapError(() => fail("confirm recovery of")),
    );

export const decodeEnrollmentSessions = (serialized: string, attemptId: string) =>
  Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Array(
        Schema.Struct({
          sessionId: AuthSessionId,
          subject: Schema.String,
        }),
      ),
    ),
  )(serialized).pipe(
    Effect.map((sessions) =>
      sessions
        .filter((session) => session.subject === `workjet-desktop-enrollment:${attemptId}`)
        .map((session) => session.sessionId),
    ),
    Effect.mapError(() => fail("reconcile the exact enrollment for")),
  );

/** One main-owned store and enrollment lock, shared by all windows and callers. */
export const makeSessionAccess = Effect.fn("desktop.localServiceSession.access")(function* (
  dependencies: LocalSessionDependencies,
) {
  const lock = yield* Semaphore.make(1);
  const stores = new Map<string, Store>();
  const uncertainEnrollments = new Set<string>();
  const recoveryRequested = new Set<string>();
  const prepare = (config: DesktopBackendStartConfig) =>
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
        const credentialStore = store;
        return yield* credentialStore
          .withAccess(
            Effect.gen(function* () {
              yield* credentialStore.assertEnrollmentSettled.pipe(
                Effect.mapError(() => fail("reconcile an incomplete enrollment for")),
              );
              const saved = yield* credentialStore.get.pipe(
                Effect.mapError(() => fail("read or unlock")),
              );
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
                return { target, credential: saved.value };
              }
              yield* credentialStore.requireProtection.pipe(Effect.mapError(() => fail("protect")));
              // Issue/revoke cannot be interrupted halfway through. Saving and validation
              // remain interruptible and bounded, including a pending OS keychain dialog.
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const enrollmentId = yield* credentialStore.beginEnrollment.pipe(
                    Effect.mapError(() => fail("record enrollment intent for")),
                  );
                  uncertainEnrollments.add(target.baseDir);
                  const issued = yield* dependencies.issue(config, target, enrollmentId);
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
                    yield* credentialStore
                      .save(credential)
                      .pipe(Effect.mapError((error) => fail(`${error.operation} credential for`)));
                    return { target, credential };
                  });
                  const result = yield* Effect.exit(
                    persist.pipe(Effect.timeout("30 seconds"), Effect.interruptible),
                  );
                  if (Exit.isSuccess(result)) {
                    yield* credentialStore
                      .finishEnrollment(enrollmentId)
                      .pipe(Effect.mapError(() => fail("settle enrollment for")));
                    uncertainEnrollments.delete(target.baseDir);
                    return result.value;
                  }
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
                  yield* credentialStore
                    .finishEnrollment(enrollmentId)
                    .pipe(Effect.mapError(() => fail("settle enrollment for")));
                  uncertainEnrollments.delete(target.baseDir);
                  const error = Cause.findErrorOption(result.cause);
                  if (Option.isSome(error) && Schema.is(LocalServiceSessionError)(error.value))
                    return yield* error.value;
                  return yield* fail("save or validate");
                }),
              );
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              Schema.is(LocalServiceSessionError)(error)
                ? error
                : fail("acquire exclusive access to"),
            ),
          );
      }),
    );
  const recover = (config: DesktopBackendStartConfig) =>
    lock.withPermit(
      Effect.gen(function* () {
        const target = yield* dependencies.discover(config);
        if (recoveryRequested.has(target.baseDir))
          return yield* fail("repeat an unconfirmed recovery of");
        let store = stores.get(target.baseDir);
        if (store === undefined) {
          store = yield* dependencies.openStore(target);
          stores.set(target.baseDir, store);
        }
        const credentialStore = store;
        return yield* credentialStore
          .withAccess(
            Effect.gen(function* () {
              const recovery = yield* credentialStore.inspectRecovery;
              if (
                recovery.baseDir !== target.baseDir ||
                recovery.environmentId !== target.environmentId
              )
                return yield* fail("verify the recovery target for");
              yield* credentialStore.requireProtection;
              recoveryRequested.add(target.baseDir);
              if (!(yield* dependencies.confirmRecovery(target)))
                return yield* fail("recover after cancelling");
              const ids = new Set<string>(
                recovery.sessionId === undefined ? [] : [recovery.sessionId],
              );
              if (recovery.attemptId !== undefined) {
                const enrolled = yield* dependencies.listEnrollmentSessions(
                  config,
                  target,
                  recovery.attemptId,
                );
                for (const id of enrolled) ids.add(id);
              }
              // A lost revoke reply preserves every recovery file for an explicit retry.
              for (const id of ids) yield* dependencies.revoke(config, target, id);
              yield* credentialStore.retireRecovered(recovery);
              uncertainEnrollments.delete(target.baseDir);
            }),
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new LocalServiceSessionError({
                  operation: Schema.is(LocalServiceSessionError)(error)
                    ? error.operation
                    : "complete the explicit recovery of",
                  recoveryAttempted: recoveryRequested.has(target.baseDir),
                }),
            ),
          );
      }),
    );
  const prepareWithRecovery = (config: DesktopBackendStartConfig) =>
    prepare(config).pipe(
      Effect.catch((original) =>
        original.retryable
          ? Effect.fail(original)
          : recover(config).pipe(
              Effect.andThen(prepare(config)),
              Effect.mapError((error) => (error.recoveryAttempted ? error : original)),
            ),
      ),
    );
  return {
    prepare,
    recover,
    prepareWithRecovery,
    get: (config: DesktopBackendStartConfig) =>
      prepare(config).pipe(Effect.map(({ credential }) => Redacted.value(credential.token))),
  };
});

/** Captures CLI stdout only in memory. Neither command arguments nor diagnostics contain bearer tokens. */
export const runLocalCli = (
  config: Pick<
    DesktopBackendStartConfig,
    "executablePath" | "entryPath" | "cwd" | "env" | "extendEnv"
  >,
  args: ReadonlyArray<string>,
  timeout: "30 seconds" | "5 minutes" = "30 seconds",
) => {
  const command: LocalCliCommandFailure["command"] =
    args[0] === "__desktop-target"
      ? "service-discovery"
      : args[0] !== "service"
      ? "authorization"
      : args[1] === "install"
        ? "service-install"
        : args[1] === "status"
          ? "service-status"
          : args[1] === "start"
            ? "service-start"
            : "service-other";
  const failure = (
    kind: LocalCliCommandFailure["kind"],
    details: Pick<LocalCliCommandFailure, "exitCode" | "step"> = {},
  ) =>
    new LocalServiceSessionError({
      operation: "run the local authorization command for",
      commandFailure: { command, kind, ...details },
    });
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner
        .spawn(
          ChildProcess.make(config.executablePath, [config.entryPath, ...args], {
            cwd: config.cwd,
            env: config.env,
            extendEnv: config.extendEnv,
            killSignal: "SIGKILL",
          }),
        )
        .pipe(Effect.mapError(() => failure("spawn")));
      const readBounded = (stream: typeof child.stdout) =>
        Effect.gen(function* () {
          const chunks: Uint8Array[] = [];
          let size = 0;
          yield* Stream.runForEach(stream, (chunk) =>
            Effect.gen(function* () {
              size += chunk.byteLength;
              if (size > 64 * 1024) return yield* failure("output-limit");
              chunks.push(chunk);
            }),
          ).pipe(
            Effect.mapError((error) =>
              Schema.is(LocalServiceSessionError)(error) ? error : failure("read"),
            ),
          );
          return Buffer.concat(chunks).toString("utf8");
        });
      const [stdout, stderr] = yield* Effect.all(
        [readBounded(child.stdout), readBounded(child.stderr)],
        {
          concurrency: 2,
        },
      );
      const exitCode = yield* child.exitCode.pipe(Effect.mapError(() => failure("read")));
      if (exitCode !== 0) {
        // Effect CLI failures can arrive on either stream. Only fixed step
        // identifiers leave memory; output and arguments can contain credentials.
        const diagnostics = `${stderr}\n${stdout}`;
        const step: LocalCliCommandFailure["step"] =
          command !== "service-install"
            ? undefined
            : diagnostics.includes("staging the bundled runtime") ||
                diagnostics.includes("stageBundledRuntime")
              ? "bundle-staging"
              : diagnostics.includes("verifying the pinned workjet runtime")
                ? "runtime-verification"
                : diagnostics.includes("starting the LaunchAgent")
                  ? "service-start"
                  : undefined;
        return yield* failure("exit", {
          exitCode: Number(exitCode),
          ...(step === undefined ? {} : { step }),
        });
      }
      return stdout;
    }),
  ).pipe(
    Effect.timeout(timeout),
    Effect.mapError((error) =>
      Schema.is(LocalServiceSessionError)(error)
        ? error
        : failure(Cause.isTimeoutError(error) ? "timeout" : "read"),
    ),
    Effect.tapError((error) =>
      args[0] === "service"
        ? Effect.logError("local background-service command failed", error.commandFailure)
        : Effect.void,
    ),
  );
};
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
    readonly attach: (
      config: DesktopBackendStartConfig,
    ) => Effect.Effect<RpcSession, LocalServiceSessionError, Scope.Scope>;
  }
>()("@workjet/desktop/backend/DesktopLocalServiceSession") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const dialog = yield* ElectronDialog;
  const runCli = (config: DesktopBackendStartConfig, args: ReadonlyArray<string>) =>
    runLocalCli(config, args).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  const http = yield* HttpClient.HttpClient;
  const rpc = yield* RpcSessionFactory;
  const storeContext = yield* Effect.context<Effect.Services<ReturnType<typeof Credential.make>>>();
  const connect = (target: LocalServiceTarget, credential: Credential.LocalServiceCredential) =>
    Effect.gen(function* () {
      const wsBaseUrl = target.origin.replace(/^http:/, "ws:");
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        httpBaseUrl: target.origin,
        wsBaseUrl,
        bearerToken: Redacted.value(credential.token),
      }).pipe(
        Effect.mapError((error) =>
          error instanceof RemoteEnvironmentAuthFetchError ||
          error instanceof RemoteEnvironmentAuthTimeoutError ||
          Schema.is(EnvironmentInternalError)(error) ||
          (error instanceof RemoteEnvironmentAuthUndeclaredStatusError &&
            (error.status === 408 || error.status === 429 || error.status >= 500))
            ? retry("reach")
            : fail("authenticate the current server generation for"),
        ),
      );
      const connectionTarget = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make(target.environmentId),
        label: "Workjet Desktop",
        httpBaseUrl: target.origin,
        wsBaseUrl,
      });
      const session = yield* rpc
        .connect({
          ...connectionTarget,
          runtimeInstanceId: target.runtimeInstanceId,
          socketUrl,
          httpAuthorization: null,
          target: connectionTarget,
        })
        .pipe(Effect.mapError(classifySessionRpcError));
      yield* session.ready.pipe(Effect.mapError(classifySessionRpcError));
      const initialConfig = yield* session.initialConfig.pipe(
        Effect.mapError(classifySessionRpcError),
      );
      if (initialConfig.environment.serverVersion !== target.serverVersion)
        return yield* fail("verify the server version for");
      return session;
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.timeout("20 seconds"),
      Effect.mapError(classifySessionConnectionFailure),
    );
  const access = yield* makeSessionAccess({
    confirmRecovery: (target) => requestLocalSessionRecoveryConsent(dialog, target),
    listEnrollmentSessions: (config, target, attemptId) =>
      runCli(config, ["auth", "session", "list", ...identityArgs(target), "--json"]).pipe(
        Effect.flatMap((serialized) => decodeEnrollmentSessions(serialized, attemptId)),
        Effect.mapError(() => fail("reconcile the exact enrollment for")),
      ),
    discover: (config) =>
      Effect.gen(function* () {
        if (config.localSession === undefined || !isLocalServiceOrigin(config.httpBaseUrl.href))
          return yield* fail("resolve");
        const baseDir = yield* fs
          .realPath(config.localSession.baseDir)
          .pipe(Effect.mapError(() => fail("resolve the profile for")));
        const target = yield* runCli(config, ["__desktop-target", "--base-dir", baseDir]).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LocalServiceTarget))),
          Effect.mapError(classifyLocalServiceDiscoveryFailure),
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
    issue: (config, target, enrollmentId) =>
      runCli(config, [
        "auth",
        "session",
        "issue",
        ...identityArgs(target),
        "--label",
        "Workjet Desktop",
        "--subject",
        `workjet-desktop-enrollment:${enrollmentId}`,
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
      Effect.scoped(connect(target, credential)).pipe(Effect.asVoid),
  });
  const prepare = access.prepareWithRecovery;
  return {
    get: (config: DesktopBackendStartConfig) =>
      prepare(config).pipe(Effect.map(({ credential }) => Redacted.value(credential.token))),
    attach: (config: DesktopBackendStartConfig) =>
      prepare(config).pipe(Effect.flatMap(({ target, credential }) => connect(target, credential))),
  };
});
export const layer = Layer.effect(DesktopLocalServiceSession, make);
