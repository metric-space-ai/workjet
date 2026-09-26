import { waitForHttpReady } from "@workjet/shared/httpReadiness";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  runBackendProcess,
  type BackendProcessExit,
  type RunBackendProcessOptions,
} from "./DesktopBackendManager.ts";
import { DesktopLocalServiceSession, runLocalCli } from "./DesktopLocalServiceSession.ts";
import { attachDesktopServiceTelemetry } from "./DesktopServiceTelemetry.ts";
import * as Crypto from "effect/Crypto";

export class LocalServiceAttachmentError extends Schema.TaggedErrorClass<LocalServiceAttachmentError>()(
  "LocalServiceAttachmentError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `${this.reason} The saved service was not replaced. Repair its configuration before reopening Workjet.`;
  }
}
const blocked = (reason: string) => new LocalServiceAttachmentError({ reason });

const DesktopEndpoint = Schema.Struct({
  port: Schema.Int,
  host: Schema.Literals(["127.0.0.1", "::1"]),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: Schema.Int,
});
type Endpoint = typeof DesktopEndpoint.Type;
const ServiceStatus = Schema.Struct({
  supported: Schema.Boolean,
  installed: Schema.Boolean,
  current: Schema.Boolean,
  desktop: Schema.optionalKey(DesktopEndpoint),
});

export interface AttachmentDependencies {
  readonly discover: Effect.Effect<Option.Option<Endpoint>, LocalServiceAttachmentError>;
  readonly assertCurrent: Effect.Effect<void, LocalServiceAttachmentError>;
  readonly start: Effect.Effect<void, LocalServiceAttachmentError>;
  readonly connect: (input: RunBackendProcessOptions) => Effect.Effect<
    {
      readonly closed: Effect.Effect<never, Error>;
    },
    LocalServiceAttachmentError,
    Scope.Scope
  >;
}

/** A service is started once per UI launch. Reconnection must not undo an explicit external stop. */
export const makeAttachment = Effect.fn("desktop.localServiceAttachment.make")(function* (
  dependencies: AttachmentDependencies,
) {
  let selection: Option.Option<Endpoint> | undefined;
  let startRequested = false;
  const resolvePort = Effect.gen(function* () {
    if (selection === undefined) selection = yield* dependencies.discover;
    return Option.map(selection, (endpoint) => endpoint.port);
  });
  const run: typeof runBackendProcess = (input) =>
    Effect.suspend(() => {
      if (selection === undefined)
        return Effect.succeed<BackendProcessExit>({
          code: Option.none(),
          reason: "The local service must be resolved before starting a backend.",
          restart: false,
        });
      if (Option.isNone(selection)) return runBackendProcess(input);
      const endpoint = selection.value;
      return Effect.gen(function* () {
        if (
          input.localSession === undefined ||
          input.bootstrap.port !== endpoint.port ||
          input.bootstrap.host !== endpoint.host ||
          input.bootstrap.tailscaleServeEnabled !== endpoint.tailscaleServeEnabled ||
          input.bootstrap.tailscaleServePort !== endpoint.tailscaleServePort
        )
          return yield* blocked(
            "The Desktop settings do not match the installed service endpoint.",
          );
        yield* dependencies.assertCurrent;
        if (!startRequested) {
          // Mark before issuing: an uncertain reply must not become repeated control requests.
          startRequested = true;
          yield* dependencies.start;
        }
        const session = yield* dependencies.connect(input);
        yield* input.onReady?.() ?? Effect.void;
        return yield* session.closed.pipe(
          Effect.catch(() =>
            Effect.succeed<BackendProcessExit>({
              code: Option.none(),
              reason:
                "The authenticated service connection closed; reconnecting without restarting it.",
            }),
          ),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed<BackendProcessExit>({
            code: Option.none(),
            reason: error.message,
            restart: false,
          }),
        ),
      );
    });
  return { resolvePort, run };
});

export class DesktopLocalServiceAttachment extends Context.Service<
  DesktopLocalServiceAttachment,
  Effect.Success<ReturnType<typeof makeAttachment>>
>()("@workjet/desktop/backend/DesktopLocalServiceAttachment") {}

export const layer = Layer.effect(
  DesktopLocalServiceAttachment,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const sessions = yield* DesktopLocalServiceSession;
    const http = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;
    const cli = {
      executablePath: process.execPath,
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      extendEnv: true,
    };
    const profileArgs = ["--base-dir", environment.baseDir];
    let artifactArgs: ReadonlyArray<string> = [];
    const status = () =>
      runLocalCli(cli, ["service", "status", ...profileArgs, ...artifactArgs, "--json"]).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServiceStatus))),
        Effect.mapError(() => blocked("Could not inspect the installed local service.")),
      );
    const assertCurrent = Effect.gen(function* () {
      const saved = yield* status();
      if (!saved.supported || !saved.installed || !saved.current || saved.desktop === undefined)
        return yield* blocked("The installed local service needs an explicit update or repair.");
    });
    return yield* makeAttachment({
      discover: Effect.gen(function* () {
        if (
          environment.isDevelopment ||
          !environment.isPackaged ||
          (environment.platform !== "darwin" && environment.platform !== "linux")
        )
          return Option.none();
        const initial = yield* status();
        if (!initial.installed) {
          // A preserved or damaged service profile is not permission to launch a second owner.
          const retained = yield* fs.exists(
            environment.path.join(environment.baseDir, "runtime", "service-state.json"),
          );
          if (retained) return yield* blocked("Service state exists without an installed service.");
          return Option.none();
        }
        if (environment.platform !== "darwin")
          return yield* blocked("Desktop attachment requires a profile-specific service manager.");
        if (environment.processArch !== "arm64" && environment.processArch !== "x64")
          return yield* blocked("The app has no bundled runtime for this architecture.");
        const filename = `workjet-server-darwin-${environment.processArch}.tgz`;
        const archive = environment.path.join(environment.resourcesPath, "ssh-servers", filename);
        const checksum = yield* fs.readFileString(`${archive}.sha256`);
        const match = /^([a-f0-9]{64})  ([^\r\n]+)\r?\n?$/.exec(checksum);
        if (match?.[1] === undefined || match[2] !== filename || !(yield* fs.exists(archive)))
          return yield* blocked("The shipped runtime archive or checksum is unavailable.");
        artifactArgs = ["--bundle-archive", archive, "--bundle-sha256", match[1]];
        const saved = yield* status();
        const endpoint = saved.desktop;
        if (
          !saved.supported ||
          !saved.installed ||
          !saved.current ||
          endpoint === undefined ||
          endpoint.port < 1 ||
          endpoint.port > 65535 ||
          endpoint.tailscaleServePort < 1 ||
          endpoint.tailscaleServePort > 65535
        )
          return yield* blocked("The installed local service does not match this app's runtime.");
        if (
          Option.isSome(environment.configuredBackendPort) &&
          environment.configuredBackendPort.value !== endpoint.port
        )
          return yield* blocked(
            "The configured Desktop port differs from the installed service port.",
          );
        artifactArgs = [
          ...artifactArgs,
          "--desktop-port",
          String(endpoint.port),
          "--desktop-host",
          endpoint.host,
          "--desktop-tailscale-serve-port",
          String(endpoint.tailscaleServePort),
          ...(endpoint.tailscaleServeEnabled ? ["--desktop-tailscale-serve"] : []),
        ];
        return Option.some(endpoint);
      }).pipe(
        Effect.mapError((error) =>
          error instanceof LocalServiceAttachmentError
            ? error
            : blocked("Could not read the local service configuration."),
        ),
      ),
      assertCurrent,
      start: Effect.suspend(() =>
        runLocalCli(cli, ["service", "start", ...profileArgs, ...artifactArgs]),
      ).pipe(
        Effect.asVoid,
        Effect.mapError(() => blocked("Could not start the installed local service.")),
      ),
      connect: (input) =>
        Effect.gen(function* () {
          yield* waitForHttpReady({
            baseUrl: input.httpBaseUrl.href,
            path: "/.well-known/workjet/environment",
            timeoutMs: 30_000,
            makeError: () => blocked("The installed local service did not become reachable."),
          });
          // Readiness is published only after profile, generation, version and credential validation.
          const session = yield* sessions.attach(input);
          return yield* attachDesktopServiceTelemetry(session, input).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
          );
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.mapError((error) =>
            error instanceof LocalServiceAttachmentError ? error : blocked(error.message),
          ),
        ),
    });
  }),
);
