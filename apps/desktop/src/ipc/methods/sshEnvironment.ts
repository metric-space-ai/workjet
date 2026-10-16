import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
  issueRemoteWebSocketTicket,
  RemoteEnvironmentAuthUndeclaredStatusError,
  type RemoteEnvironmentAuthError,
} from "@workjet/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@workjet/client-runtime/environment";
import {
  EnvironmentAuthInvalidError,
  DesktopDiscoveredSshHostSchema,
  DesktopSshBearerBootstrapInputSchema,
  DesktopSshBearerRequestInputSchema,
  DesktopSshEnvironmentEnsureInputSchema,
  DesktopSshEnvironmentEnsureResultSchema,
  DesktopSshEnvironmentTargetSchema,
  DesktopSshHttpBaseUrlInputSchema,
  DesktopSshPasswordPromptCancelledType,
  type DesktopSshEnvironmentProgress,
  DesktopSshPasswordPromptResolutionInputSchema,
  ExecutionEnvironmentDescriptor,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  AuthAccessTokenResult,
  AuthSessionState,
  AuthWebSocketTicketResult,
} from "@workjet/contracts";
import { SshHttpBridgeError } from "@workjet/ssh/errors";
import {
  resolveLoopbackSshHttpBaseUrl,
  type SshEnvironmentProgressListener,
} from "@workjet/ssh/tunnel";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { DesktopComputers } from "../../computers/DesktopComputers.ts";
import * as DesktopSshPasswordPrompts from "../../ssh/DesktopSshPasswordPrompts.ts";

type DesktopSshEnvironmentRequestOperation =
  | "fetch-environment-descriptor"
  | "bootstrap-bearer-session"
  | "fetch-session-state"
  | "issue-websocket-ticket";

type DesktopSshEnvironmentRequestCause = RemoteEnvironmentAuthError | SshHttpBridgeError;

const isEnvironmentAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);
const isEnvironmentInternalError = Schema.is(EnvironmentInternalError);
const isEnvironmentOperationForbiddenError = Schema.is(EnvironmentOperationForbiddenError);
const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);
const isEnvironmentScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);

function readSshHttpStatus(cause: DesktopSshEnvironmentRequestCause): number | null {
  if (
    cause instanceof RemoteEnvironmentAuthUndeclaredStatusError ||
    cause instanceof SshHttpBridgeError
  ) {
    return cause.status ?? null;
  }
  if (isEnvironmentRequestInvalidError(cause)) {
    return 400;
  }
  if (isEnvironmentAuthInvalidError(cause)) {
    return 401;
  }
  if (isEnvironmentScopeRequiredError(cause)) {
    return 403;
  }
  if (isEnvironmentOperationForbiddenError(cause)) {
    return 403;
  }
  if (isEnvironmentInternalError(cause)) {
    return 500;
  }
  return null;
}

export class DesktopSshEnvironmentRequestError extends Data.TaggedError(
  "DesktopSshEnvironmentRequestError",
)<{
  readonly operation: DesktopSshEnvironmentRequestOperation;
  readonly cause: DesktopSshEnvironmentRequestCause;
  readonly sshHttpStatus: number | null;
}> {
  override get message() {
    const prefix = this.sshHttpStatus === null ? "" : `[ssh_http:${this.sshHttpStatus}] `;
    return `${prefix}SSH remote API request failed during ${this.operation}.`;
  }
}

const withLoopbackSshApi =
  <A, R>(
    operation: DesktopSshEnvironmentRequestOperation,
    use: (httpBaseUrl: string) => Effect.Effect<A, RemoteEnvironmentAuthError, R>,
  ) =>
  (httpBaseUrl: string): Effect.Effect<A, DesktopSshEnvironmentRequestError, R> =>
    resolveLoopbackSshHttpBaseUrl(httpBaseUrl).pipe(
      Effect.flatMap(use),
      Effect.mapError(
        (cause) =>
          new DesktopSshEnvironmentRequestError({
            operation,
            cause,
            sshHttpStatus: readSshHttpStatus(cause),
          }),
      ),
    );

export const discoverSshHosts = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopDiscoveredSshHostSchema),
  handler: Effect.fn("desktop.ipc.sshEnvironment.discoverHosts")(function* () {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.discoverHosts();
  }),
});

export const ensureSshEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL,
  payload: DesktopSshEnvironmentEnsureInputSchema,
  result: DesktopSshEnvironmentEnsureResultSchema,
  handler: Effect.fn("desktop.ipc.sshEnvironment.ensureEnvironment")(function* ({
    target,
    options,
  }) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    // Live steps for the add-computer row (Verbinden → Kopieren → Starten).
    const windows = yield* Effect.serviceOption(ElectronWindow.ElectronWindow);
    const onProgress: SshEnvironmentProgressListener = (step) =>
      windows._tag === "Some"
        ? windows.value.sendAll(IpcChannels.SSH_ENVIRONMENT_PROGRESS_CHANNEL, {
            alias: target.alias,
            hostname: target.hostname,
            ...step,
          } satisfies DesktopSshEnvironmentProgress)
        : Effect.void;
    const bootstrap = yield* sshEnvironment
      .ensureEnvironment(target, { ...options, onProgress })
      .pipe(
        Effect.catch((error) =>
          DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(error)
            ? Effect.succeed({
                type: DesktopSshPasswordPromptCancelledType,
                message: error.message,
              })
            : Effect.fail(error),
        ),
      );
    if ("target" in bootstrap) {
      const computers = yield* Effect.serviceOption(DesktopComputers);
      if (computers._tag === "Some") {
        yield* computers.value.discoverConnected({
          httpBaseUrl: bootstrap.httpBaseUrl,
          label: target.alias || target.hostname,
          connection: { _tag: "ssh", target: bootstrap.target },
        });
      }
    }
    return bootstrap;
  }),
});

/**
 * „Rechner hinzufügen“ mit Passwort: Desktop-Schlüssel einmalig ins
 * authorized_keys des Ziels eintragen. Das Passwort läuft über die
 * vorhandene SSH_ASKPASS-Abfrage, nie über diesen Kanal.
 */
export const installComputerSshKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INSTALL_COMPUTER_SSH_KEY_CHANNEL,
  payload: DesktopSshEnvironmentTargetSchema,
  result: Schema.Struct({ ok: Schema.Boolean, message: Schema.String }),
  handler: Effect.fn("desktop.ipc.sshEnvironment.installComputerSshKey")(function* (target) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    if (!sshEnvironment.installAuthorizedKey)
      return { ok: false, message: "Schlüsseleintrag nicht verfügbar." };
    return yield* sshEnvironment.installAuthorizedKey(target).pipe(
      Effect.as({ ok: true, message: "" }),
      Effect.catch((error) =>
        Effect.succeed({
          ok: false,
          message:
            "stderr" in error && typeof error.stderr === "string" && error.stderr
              ? error.stderr
              : error.message,
        }),
      ),
    );
  }),
});

export const disconnectSshEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL,
  payload: Schema.Union([
    DesktopSshEnvironmentTargetSchema,
    Schema.Struct({
      target: DesktopSshEnvironmentTargetSchema,
      releaseOnly: Schema.Literal(true),
    }),
  ]),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironment.disconnectEnvironment")(function* (input) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    if ("releaseOnly" in input) {
      yield* sshEnvironment.releaseEnvironment(input.target);
    } else {
      yield* sshEnvironment.disconnectEnvironment(input);
    }
  }),
});

export const fetchSshEnvironmentDescriptor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL,
  payload: DesktopSshHttpBaseUrlInputSchema,
  result: ExecutionEnvironmentDescriptor,
  handler: Effect.fn("desktop.ipc.sshEnvironment.fetchDescriptor")(function* ({ httpBaseUrl }) {
    return yield* withLoopbackSshApi("fetch-environment-descriptor", (resolvedHttpBaseUrl) =>
      fetchRemoteEnvironmentDescriptor({ httpBaseUrl: resolvedHttpBaseUrl }),
    )(httpBaseUrl);
  }),
});

export const bootstrapSshBearerSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL,
  payload: DesktopSshBearerBootstrapInputSchema,
  result: AuthAccessTokenResult,
  handler: Effect.fn("desktop.ipc.sshEnvironment.bootstrapBearerSession")(function* ({
    httpBaseUrl,
    credential,
  }) {
    return yield* withLoopbackSshApi("bootstrap-bearer-session", (resolvedHttpBaseUrl) =>
      bootstrapRemoteBearerSession({
        httpBaseUrl: resolvedHttpBaseUrl,
        credential,
      }),
    )(httpBaseUrl);
  }),
});

export const fetchSshSessionState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL,
  payload: DesktopSshBearerRequestInputSchema,
  result: AuthSessionState,
  handler: Effect.fn("desktop.ipc.sshEnvironment.fetchSessionState")(function* ({
    httpBaseUrl,
    bearerToken,
  }) {
    return yield* withLoopbackSshApi("fetch-session-state", (resolvedHttpBaseUrl) =>
      fetchRemoteSessionState({
        httpBaseUrl: resolvedHttpBaseUrl,
        bearerToken,
      }),
    )(httpBaseUrl);
  }),
});

export const issueSshWebSocketTicket = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL,
  payload: DesktopSshBearerRequestInputSchema,
  result: AuthWebSocketTicketResult,
  handler: Effect.fn("desktop.ipc.sshEnvironment.issueWebSocketTicket")(function* ({
    httpBaseUrl,
    bearerToken,
  }) {
    return yield* withLoopbackSshApi("issue-websocket-ticket", (resolvedHttpBaseUrl) =>
      issueRemoteWebSocketTicket({
        httpBaseUrl: resolvedHttpBaseUrl,
        bearerToken,
      }),
    )(httpBaseUrl);
  }),
});

export const resolveSshPasswordPrompt = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL,
  payload: DesktopSshPasswordPromptResolutionInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironment.resolvePasswordPrompt")(function* ({
    requestId,
    password,
  }) {
    const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
    yield* prompts.resolve({ requestId, password });
  }),
});
