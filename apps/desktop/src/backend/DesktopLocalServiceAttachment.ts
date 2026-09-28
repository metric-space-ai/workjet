import { PortSchema } from "@workjet/contracts";
import { waitForHttpReady } from "@workjet/shared/httpReadiness";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { ElectronDialog } from "../electron/ElectronDialog.ts";
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
    return `${this.reason} No foreground replacement was started. Repair the service configuration before reopening Workjet.`;
  }
}
const blocked = (reason: string) => new LocalServiceAttachmentError({ reason });
// A first install unpacks the bundled runtime; keep it bounded without applying
// the short authorization/status deadline to that disk-heavy operation.
const SERVICE_INSTALL_TIMEOUT = "5 minutes";

const DesktopEndpoint = Schema.Struct({
  port: PortSchema,
  host: Schema.Literals(["127.0.0.1", "::1"]),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
});
type Endpoint = typeof DesktopEndpoint.Type;
const ServiceStatus = Schema.Struct({
  supported: Schema.Boolean,
  installed: Schema.Boolean,
  current: Schema.Boolean,
  desktop: Schema.optionalKey(DesktopEndpoint),
});
type Discovery = Option.Option<Endpoint> | "install" | "migrate";

const endpointArgs = (endpoint: Endpoint): ReadonlyArray<string> => [
  "--desktop-port",
  String(endpoint.port),
  "--desktop-host",
  endpoint.host,
  "--desktop-tailscale-serve-port",
  String(endpoint.tailscaleServePort),
  ...(endpoint.tailscaleServeEnabled ? ["--desktop-tailscale-serve"] : []),
];

/** Discovery is read-only; the selected endpoint does not exist until Desktop configures exposure. */
export const discoverService = Effect.fn("desktop.localServiceAttachment.discover")(
  function* (input: {
    readonly environment: {
      readonly isDevelopment: boolean;
      readonly isPackaged: boolean;
      readonly platform: string;
      readonly processArch: string;
      readonly baseDir: string;
      readonly resourcesPath: string;
      readonly configuredBackendPort: Option.Option<number>;
      readonly path: { readonly join: (...parts: ReadonlyArray<string>) => string };
    };
    readonly fs: FileSystem.FileSystem;
    readonly status: (
      artifactArgs: ReadonlyArray<string>,
    ) => Effect.Effect<typeof ServiceStatus.Type, LocalServiceAttachmentError>;
  }) {
    const { environment, fs } = input;
    const foreground = {
      selection: Option.none<Endpoint>(),
      artifactArgs: [] as ReadonlyArray<string>,
    };
    if (
      environment.isDevelopment ||
      !environment.isPackaged ||
      (environment.platform !== "darwin" && environment.platform !== "linux")
    )
      return foreground;
    const initial = yield* input.status([]);
    let setup: "install" | "migrate" = "install";
    if (!initial.installed) {
      const runtimeDir = environment.path.join(environment.baseDir, "runtime");
      const runtimeEntries = (yield* fs.exists(runtimeDir))
        ? yield* fs.readDirectory(runtimeDir)
        : [];
      const migration = runtimeEntries.includes("desktop-profile-migration.json");
      if (runtimeEntries.includes("service-state.json") && !migration)
        return yield* blocked("Service state exists without an installed service.");
      const stateDir = environment.path.join(environment.baseDir, "userdata");
      const entries = (yield* fs.exists(stateDir)) ? yield* fs.readDirectory(stateDir) : [];
      const hasDatabase = yield* fs.exists(environment.path.join(stateDir, "state.sqlite"));
      if (hasDatabase) setup = "migrate";
      else if (
        migration ||
        entries.some((entry) => entry === "state.sqlite" || entry.startsWith("state.sqlite-"))
      )
        return yield* blocked("This incomplete profile needs explicit recovery before migration.");
    }
    if (!initial.supported)
      return yield* blocked("The background service is not available on this machine.");
    if (environment.processArch !== "arm64" && environment.processArch !== "x64")
      return yield* blocked("The app has no bundled runtime for this architecture.");
    const filename = `workjet-server-${environment.platform}-${environment.processArch}.tgz`;
    const archive = environment.path.join(environment.resourcesPath, "ssh-servers", filename);
    const checksum = yield* fs.readFileString(`${archive}.sha256`);
    const match = /^([a-f0-9]{64})  ([^\r\n]+)\r?\n?$/.exec(checksum);
    if (match?.[1] === undefined || match[2] !== filename || !(yield* fs.exists(archive)))
      return yield* blocked("The shipped runtime archive or checksum is unavailable.");
    const artifactArgs = ["--bundle-archive", archive, "--bundle-sha256", match[1]];
    if (!initial.installed) return { selection: setup, artifactArgs };
    const saved = yield* input.status(artifactArgs);
    const endpoint = saved.desktop;
    if (!saved.supported || !saved.installed || !saved.current || endpoint === undefined)
      return yield* blocked("The installed local service does not match this app's runtime.");
    if (
      Option.isSome(environment.configuredBackendPort) &&
      environment.configuredBackendPort.value !== endpoint.port
    )
      return yield* blocked("The configured Desktop port differs from the installed service port.");
    return {
      selection: Option.some(endpoint),
      artifactArgs: [...artifactArgs, ...endpointArgs(endpoint)],
    };
  },
  Effect.mapError((error) =>
    Schema.is(LocalServiceAttachmentError)(error)
      ? error
      : blocked("Could not read the local service configuration."),
  ),
);

export interface AttachmentDependencies {
  readonly discover: Effect.Effect<Discovery, LocalServiceAttachmentError>;
  readonly install: (endpoint: Endpoint) => Effect.Effect<void, LocalServiceAttachmentError>;
  readonly confirmMigration: Effect.Effect<boolean, LocalServiceAttachmentError>;
  readonly migrate: (endpoint: Endpoint) => Effect.Effect<void, LocalServiceAttachmentError>;
  readonly assertCurrent: Effect.Effect<void, LocalServiceAttachmentError>;
  readonly start: Effect.Effect<void, LocalServiceAttachmentError>;
  readonly connect: (
    input: RunBackendProcessOptions,
  ) => Effect.Effect<
    { readonly closed: Effect.Effect<never, Error> },
    LocalServiceAttachmentError,
    Scope.Scope
  >;
}

/** Installation/start is requested once. Reconnection never undoes an external stop. */
export const makeAttachment = Effect.fn("desktop.localServiceAttachment.make")(function* (
  dependencies: AttachmentDependencies,
) {
  let selection: Discovery | undefined;
  let startRequested = false;
  const resolvePort = Effect.gen(function* () {
    if (selection === undefined) selection = yield* dependencies.discover;
    return typeof selection === "string"
      ? Option.none<number>()
      : Option.map(selection, (endpoint) => endpoint.port);
  });
  const run: typeof runBackendProcess = (input) =>
    Effect.suspend(() => {
      const current = selection;
      if (current === undefined)
        return Effect.succeed<BackendProcessExit>({
          code: Option.none(),
          reason: "The local service must be resolved before starting a backend.",
          restart: false,
        });
      if (typeof current !== "string" && Option.isNone(current)) return runBackendProcess(input);
      return Effect.gen(function* () {
        if (input.localSession === undefined)
          return yield* blocked("The local service requires a protected Desktop session.");
        const candidate = yield* Schema.decodeUnknownEffect(DesktopEndpoint)(input.bootstrap).pipe(
          Effect.mapError(() =>
            blocked("The Desktop settings do not provide a valid local service endpoint."),
          ),
        );
        if (typeof current === "string") {
          if (startRequested)
            return yield* blocked(
              "The previous service installation did not complete with a confirmed result.",
            );
          // Set before issuing: a lost response must not repeat an install or start a foreground owner.
          startRequested = true;
          if (current === "migrate") {
            if (!(yield* dependencies.confirmMigration))
              return yield* blocked("Profile migration was cancelled. Your data was not changed.");
            yield* dependencies.migrate(candidate);
          } else yield* dependencies.install(candidate);
          selection = Option.some(candidate);
        } else if (
          candidate.port !== current.value.port ||
          candidate.host !== current.value.host ||
          candidate.tailscaleServeEnabled !== current.value.tailscaleServeEnabled ||
          candidate.tailscaleServePort !== current.value.tailscaleServePort
        )
          return yield* blocked(
            "The Desktop settings do not match the installed service endpoint.",
          );
        yield* dependencies.assertCurrent;
        if (!startRequested) {
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

export const requestProfileMigrationConsent = (
  dialog: Pick<typeof ElectronDialog.Service, "showMessageBox">,
  baseDir: string,
) =>
  dialog
    .showMessageBox({
      type: "question",
      title: "Move Workjet to a background service",
      message: "Keep your existing Workjet data and continue work after closing the app.",
      detail: `Finish active work and stop older Workjet apps and command-line runtimes using this profile. Workjet will back up the database before setting up the background service.\n\nProfile: ${baseDir}`,
      buttons: ["Cancel", "Back up and migrate"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      checkboxLabel: "All previous Workjet runtimes using this profile are stopped.",
      checkboxChecked: false,
    })
    .pipe(
      Effect.map((result) => result.response === 1 && result.checkboxChecked),
      Effect.mapError(() => blocked("Could not confirm the profile migration.")),
    );

export const layer = Layer.effect(
  DesktopLocalServiceAttachment,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const sessions = yield* DesktopLocalServiceSession;
    const http = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const dialog = yield* ElectronDialog;
    const cli = {
      executablePath: process.execPath,
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      extendEnv: true,
    };
    const profileArgs = ["--base-dir", environment.baseDir];
    let artifactArgs: ReadonlyArray<string> = [];
    const status = (args: ReadonlyArray<string> = artifactArgs) =>
      runLocalCli(cli, ["service", "status", ...profileArgs, ...args, "--json"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
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
        const discovered = yield* discoverService({ environment, fs, status });
        artifactArgs = discovered.artifactArgs;
        return discovered.selection;
      }),
      install: (endpoint) =>
        Effect.gen(function* () {
          artifactArgs = [...artifactArgs, ...endpointArgs(endpoint)];
          yield* runLocalCli(
            cli,
            ["service", "install", ...profileArgs, ...artifactArgs, "--fresh-profile"],
            SERVICE_INSTALL_TIMEOUT,
          );
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(() =>
            blocked("Could not complete the first background-service installation."),
          ),
        ),
      confirmMigration: requestProfileMigrationConsent(dialog, environment.baseDir),
      migrate: (endpoint) =>
        Effect.gen(function* () {
          artifactArgs = [...artifactArgs, ...endpointArgs(endpoint)];
          yield* runLocalCli(
            cli,
            ["service", "install", ...profileArgs, ...artifactArgs, "--migrate-stopped-profile"],
            SERVICE_INSTALL_TIMEOUT,
          );
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(() =>
            blocked(
              "Could not complete the profile migration. Existing data and any backup were retained.",
            ),
          ),
        ),
      assertCurrent,
      start: Effect.suspend(() =>
        runLocalCli(cli, ["service", "start", ...profileArgs, ...artifactArgs]),
      ).pipe(
        Effect.asVoid,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
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
          const session = yield* sessions.attach(input);
          return yield* attachDesktopServiceTelemetry(session, input).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
          );
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.mapError((error) =>
            Schema.is(LocalServiceAttachmentError)(error) ? error : blocked(error.message),
          ),
        ),
    });
  }),
);
