// @effect-diagnostics nodeBuiltinImport:off - Stable launchd labels hash the canonical profile path.
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import {
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@workjet/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import {
  bundledRuntimeNodePath,
  BUNDLED_RUNTIME_RECEIPT,
  type BundledRuntimeSource,
} from "./bundledRuntime.ts";
import {
  acquireProfileOwnership,
  acquireDatabaseAccess,
  ProfileOwnershipError,
  type ProfileOwnershipKind,
} from "../profileOwnership.ts";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import {
  backupDatabaseOnce,
  databaseBackupDir,
  fingerprintDatabaseFiles,
} from "../serviceLauncher.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";
import {
  SERVICE_LAUNCHER_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  parseServiceState,
  decodeDesktopServiceLaunchConfig,
  type DesktopServiceLaunchConfig,
  serviceStateHasPendingUpdate,
  type ServiceState,
} from "./serviceProtocol.ts";

const BOOT_SERVICE_NAME = "workjet";
export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
export const BOOT_SERVICE_UNIT_ENV = "WORKJET_BOOT_SERVICE_UNIT";

/** systemd expands `%` specifiers, including in unquoted append-log paths. */
export function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

export function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

export interface BootServicePlan {
  readonly nodePath: string;
  readonly launcherPath: string;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
}

/** Pure renderer: service units cannot rely on the user's shell or PATH. */
export function renderBootServiceUnit(plan: BootServicePlan): string {
  // The user manager has no reliable network-online target; server networking retries itself.
  return [
    "[Unit]",
    "Description=Workjet server",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    `Environment=WORKJET_HOME=${quoteSystemdValue(plan.baseDir)}`,
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `ExecStart=${quoteSystemdValue(plan.nodePath)} ${quoteSystemdValue(plan.launcherPath)}`,
    // Let the launcher mark an explicit stop before it signals the server.
    // systemd still SIGKILLs the whole cgroup if graceful shutdown times out.
    "KillMode=mixed",
    // Agent tool calls run as children of the server, so they share this cgroup.
    // With the systemd default of OOMPolicy=stop, the kernel killing one greedy
    // child stops the whole unit: the server, every live agent, and the user's
    // connection. Keep running and let Restart=always cover the main process.
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** One launchd owner per canonical Workjet home; never share a label across profiles. */
export function bootServiceLaunchAgentLabel(canonicalBaseDir: string): string {
  return `dev.workjet.server.${NodeCrypto.createHash("sha256").update(canonicalBaseDir).digest("hex")}`;
}

function escapePlistString(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** launchd executes argv directly. No shell quoting, PATH or Electron UI process is involved. */
export function renderBootServiceLaunchAgent(plan: BootServicePlan): string {
  const string = (value: string) => `<string>${escapePlistString(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key>${string(bootServiceLaunchAgentLabel(plan.baseDir))}`,
    `<key>ProgramArguments</key><array>${string(plan.nodePath)}${string(plan.launcherPath)}</array>`,
    `<key>WorkingDirectory</key>${string(plan.baseDir)}`,
    `<key>EnvironmentVariables</key><dict><key>WORKJET_HOME</key>${string(plan.baseDir)}</dict>`,
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><true/>",
    "<key>ThrottleInterval</key><integer>5</integer>",
    // Give the launcher its five-second child termination grace before launchd kills the job.
    "<key>ExitTimeOut</key><integer>20</integer>",
    `<key>StandardOutPath</key>${string(plan.logPath)}`,
    `<key>StandardErrorPath</key>${string(plan.logPath)}`,
    "</dict></plist>",
    "",
  ].join("\n");
}

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup requires Linux with systemd or a macOS user login session; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedErrorClass<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Background setup failed while ${this.step}.`
      : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class BootServiceInstallError extends Schema.TaggedErrorClass<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the Workjet background service.";
  }
}

export class BootServiceUpdatePendingError extends Schema.TaggedErrorClass<BootServiceUpdatePendingError>()(
  "BootServiceUpdatePendingError",
  {},
) {
  override get message(): string {
    return "A remote server update is still pending. Wait for it to finish, then retry.";
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError
  | BootServiceUpdatePendingError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly current: boolean;
  readonly unitPath: string;
  readonly logPath: string;
  readonly loginSessionOnly?: boolean;
  readonly desktop?: DesktopServiceLaunchConfig;
}

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: Effect.Effect<BootServicePlan, BootServiceError>;
    readonly start: Effect.Effect<void, BootServiceError>;
    readonly stop: Effect.Effect<boolean, BootServiceError>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("workjet/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
  readonly launcherSourcePath?: string;
  readonly bundle?: BundledRuntimeSource;
  readonly desktop?: DesktopServiceLaunchConfig;
  readonly requireFreshProfile?: boolean;
  readonly migrateStoppedProfile?: boolean;
}

const MigrationFiles = Schema.Struct({
  database: Schema.String,
  wal: Schema.NullOr(Schema.String),
  shm: Schema.NullOr(Schema.String),
});
const DesktopMigrationReceipt = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  ),
  baseDir: Schema.String,
  dbPath: Schema.String,
  targetVersion: Schema.String,
  bundleSha256: Schema.String,
  desktop: Schema.Struct({
    port: Schema.Int,
    host: Schema.String,
    tailscaleServeEnabled: Schema.Boolean,
    tailscaleServePort: Schema.Int,
  }),
  phase: Schema.Literals(["preparing", "backed-up"]),
  files: Schema.optionalKey(MigrationFiles),
});
const equalMigrationFiles = (left: typeof MigrationFiles.Type, right: typeof MigrationFiles.Type) =>
  left.database === right.database && left.wal === right.wal && left.shm === right.shm;

export const make = Effect.fn("cloud.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) {
  const hostExecPath = yield* HostProcessExecutablePath;
  const platform = yield* HostProcessPlatform;
  const userId = yield* HostProcessUserId;
  const homeDir = yield* Config.string("HOME").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const host = input.host ?? { execPath: hostExecPath };
  if (host.desktop !== undefined && decodeDesktopServiceLaunchConfig(host.desktop) === undefined)
    return yield* new BootServiceInstallError({ cause: "Invalid Desktop service configuration." });
  if (
    (host.requireFreshProfile || host.migrateStoppedProfile) &&
    (platform !== "darwin" || host.desktop === undefined || host.bundle === undefined)
  )
    return yield* new BootServiceInstallError({
      cause: "Desktop profile installation requires the packaged macOS runtime and endpoint.",
    });
  if (host.requireFreshProfile && host.migrateStoppedProfile)
    return yield* new BootServiceInstallError({
      cause: "Choose fresh installation or confirmed migration, not both.",
    });

  // Resolve an existing ancestor too: a new profile below a symlink must keep
  // its label after the first install creates the missing directories.
  const baseDir =
    platform === "darwin"
      ? yield* Effect.gen(function* () {
          let ancestor = path.resolve(input.baseDir);
          const missing: string[] = [];
          while (!(yield* fs.exists(ancestor))) {
            missing.unshift(path.basename(ancestor));
            const parent = path.dirname(ancestor);
            if (parent === ancestor) {
              return yield* new BootServiceInstallError({ cause: "No existing profile ancestor" });
            }
            ancestor = parent;
          }
          return path.join(yield* fs.realPath(ancestor), ...missing);
        }).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })))
      : input.baseDir;
  const launchAgentLabel = bootServiceLaunchAgentLabel(baseDir);
  const launchDomain = `gui/${userId}`;
  const launchTarget = `${launchDomain}/${launchAgentLabel}`;
  const unitDir =
    platform === "darwin"
      ? path.join(homeDir, "Library", "LaunchAgents")
      : path.join(homeDir, ".config", "systemd", "user");
  const unitPath = path.join(
    unitDir,
    platform === "darwin" ? `${launchAgentLabel}.plist` : BOOT_SERVICE_UNIT_FILE,
  );
  const logPath = path.join(input.logsDir, "boot-service.log");
  const launcherPath = path.join(baseDir, "runtime", SERVICE_LAUNCHER_FILE);
  const statePath = path.join(baseDir, "runtime", SERVICE_STATE_FILE);
  const runtimePaths = pinnedRuntimePaths(path, baseDir, input.cliVersion);
  const launcherSourcePath =
    host.bundle !== undefined
      ? path.join(path.dirname(runtimePaths.entryPath), SERVICE_LAUNCHER_FILE)
      : (host.launcherSourcePath ??
        path.join(path.dirname(runtimePaths.entryPath), SERVICE_LAUNCHER_FILE));
  const writeDurably = (filePath: string, contents: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, { recursive: true });
        const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".service-write-" });
        yield* fs.writeFileString(tempPath, contents, { mode: 0o600 });
        yield* (yield* fs.open(tempPath, { flag: "r" })).sync;
        yield* fs.rename(tempPath, filePath);
        yield* (yield* fs.open(directory, { flag: "r" })).sync;
      }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
  const plan: BootServicePlan = {
    nodePath:
      host.bundle === undefined ? host.execPath : bundledRuntimeNodePath(runtimePaths.entryPath),
    launcherPath,
    baseDir,
    logPath,
    unitPath,
  };

  const supported =
    homeDir !== "" &&
    (platform === "linux" ||
      (platform === "darwin" && userId !== undefined && Number.isInteger(userId) && userId > 0));
  const loginSessionOnly = platform === "darwin";
  const renderUnit = () =>
    platform === "darwin" ? renderBootServiceLaunchAgent(plan) : renderBootServiceUnit(plan);
  const requireSupportedHost = Effect.gen(function* () {
    if (!supported) {
      return yield* new BootServiceUnsupportedError({ platform });
    }
    if (platform === "darwin") {
      const help = yield* runStep(
        "checking support for launchctl bootout --wait",
        "/bin/launchctl",
        ["help", "bootout"],
        { timeout: Duration.seconds(5) },
      );
      if (!`${help.stdout}\n${help.stderr}`.includes("--wait")) {
        return yield* new BootServiceCommandError({
          step: "checking support for launchctl bootout --wait; this macOS version lacks a confirmed-stop operation",
        });
      }
    }
  });

  const runStep = Effect.fn("cloud.boot_service.run_step")(function* (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeout?: Duration.Input },
  ) {
    return yield* runner.run({ command, args, timeout: options?.timeout }).pipe(
      Effect.mapError((cause) => new BootServiceCommandError({ step, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0 && !result.timedOut,
        (result) =>
          new BootServiceCommandError({
            step,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
      Effect.tapError((error) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, {
              flag: "a",
            }),
          ),
          Effect.ignore,
        ),
      ),
    );
  });

  // Never replace runtime/state files while launchd may still own a writer.
  // Old launchctl versions and uncertain stop results fail closed: a failed
  // bootout is not treated as "already stopped".
  const stopInstalledService =
    platform === "darwin"
      ? runStep(
          "waiting for the installed LaunchAgent to stop",
          "/bin/launchctl",
          ["bootout", "--wait", launchTarget],
          { timeout: Duration.seconds(30) },
        )
      : runStep(
          "stopping the installed service",
          "systemctl",
          ["--user", "stop", BOOT_SERVICE_UNIT_FILE],
          { timeout: Duration.seconds(30) },
        );
  const startService =
    platform === "darwin"
      ? runStep(
          "starting the LaunchAgent",
          "/bin/launchctl",
          ["bootstrap", launchDomain, unitPath],
          { timeout: Duration.seconds(30) },
        )
      : runStep("starting the service", "systemctl", ["--user", "restart", BOOT_SERVICE_UNIT_FILE]);

  const withOwnership = <A, E, R>(kind: ProfileOwnershipKind, work: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => acquireProfileOwnership(baseDir, kind),
            catch: (cause) => new BootServiceInstallError({ cause }),
          }),
          (ownership) => Effect.sync(() => ownership.release()),
        );
        return yield* work;
      }),
    );
  const serializeAdministration = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.andThen(requireSupportedHost, withOwnership("administration", work));

  const requireFreshProfile = Effect.gen(function* () {
    const stateDir = path.join(baseDir, "userdata");
    const entries = (yield* fs.exists(stateDir)) ? yield* fs.readDirectory(stateDir) : [];
    // Directory entries also catch dangling database symlinks and orphaned WAL files.
    const runtimeEntries = yield* fs.readDirectory(path.dirname(statePath));
    if (
      entries.some((entry) => entry === "state.sqlite" || entry.startsWith("state.sqlite-")) ||
      runtimeEntries.includes(SERVICE_STATE_FILE)
    )
      return yield* new BootServiceInstallError({
        cause:
          "This profile needs an explicit quiesced migration or service repair, not a fresh installation.",
      });
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(BootServiceInstallError)(cause) ? cause : new BootServiceInstallError({ cause }),
    ),
  );

  const prepareProfileMigration = Effect.gen(function* () {
    const desktop = host.desktop;
    const bundle = host.bundle;
    if (desktop === undefined || bundle === undefined)
      return yield* new BootServiceInstallError({
        cause: "Migration requires the selected Desktop artifact and endpoint.",
      });
    const stateDir = path.join(baseDir, "userdata");
    const dbPath = path.join(stateDir, "state.sqlite");
    const canonicalDb = yield* fs.realPath(dbPath);
    if (canonicalDb !== path.join(yield* fs.realPath(stateDir), "state.sqlite"))
      return yield* new BootServiceInstallError({
        cause: "A database file alias requires an explicit migration plan.",
      });
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => acquireDatabaseAccess(dbPath, "exclusive"),
        catch: (cause) => new BootServiceInstallError({ cause }),
      }),
      (ownership) => Effect.sync(() => ownership.release()),
    );
    const runtimePath = path.join(stateDir, "server-runtime.json");
    const stateEntries = yield* fs.readDirectory(stateDir);
    if (stateEntries.includes("server-runtime.json")) {
      const runtime = yield* fs
        .readFileString(runtimePath)
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedServerRuntimeState)),
          ),
        );
      if (runtime.pid < 1)
        return yield* new BootServiceInstallError({
          cause: "The prior runtime identity is invalid.",
        });
      const alive = yield* Effect.try({
        try: () => {
          try {
            NodeProcess.kill(runtime.pid, 0);
            return true;
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;
            throw cause;
          }
        },
        catch: (cause) => new BootServiceInstallError({ cause }),
      });
      if (alive)
        return yield* new BootServiceInstallError({
          cause: "The previous recorded runtime is still running; migration did not stop it.",
        });
    }
    const receiptPath = path.join(baseDir, "runtime", "desktop-profile-migration.json");
    const runtimeEntries = yield* fs.readDirectory(path.dirname(receiptPath));
    const receiptExists = runtimeEntries.includes("desktop-profile-migration.json");
    if (!receiptExists && runtimeEntries.includes(SERVICE_STATE_FILE))
      return yield* new BootServiceInstallError({
        cause: "Retained service state requires repair, not a new migration.",
      });
    const receipt: typeof DesktopMigrationReceipt.Type = receiptExists
      ? yield* fs
          .readFileString(receiptPath)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopMigrationReceipt)),
            ),
          )
      : {
          version: 1 as const,
          id: NodeCrypto.randomUUID(),
          baseDir,
          dbPath: canonicalDb,
          targetVersion: input.cliVersion,
          bundleSha256: bundle.sha256,
          desktop,
          phase: "preparing" as const,
        };
    if (
      receipt.baseDir !== baseDir ||
      receipt.dbPath !== canonicalDb ||
      receipt.targetVersion !== input.cliVersion ||
      receipt.bundleSha256 !== bundle.sha256 ||
      receipt.desktop.port !== desktop.port ||
      receipt.desktop.host !== desktop.host ||
      receipt.desktop.tailscaleServeEnabled !== desktop.tailscaleServeEnabled ||
      receipt.desktop.tailscaleServePort !== desktop.tailscaleServePort
    )
      return yield* new BootServiceInstallError({
        cause: "The retained migration belongs to a different profile, artifact or endpoint.",
      });
    if (runtimeEntries.includes(SERVICE_STATE_FILE)) {
      const retained = parseServiceState(yield* fs.readFileString(statePath));
      if (
        retained === undefined ||
        retained.activeVersion !== input.cliVersion ||
        retained.update !== undefined ||
        retained.desktop?.port !== desktop.port ||
        retained.desktop.host !== desktop.host ||
        retained.desktop.tailscaleServeEnabled !== desktop.tailscaleServeEnabled ||
        retained.desktop.tailscaleServePort !== desktop.tailscaleServePort
      )
        return yield* new BootServiceInstallError({
          cause: "The retained service state does not belong to this incomplete migration.",
        });
    }
    const saveReceipt = (value: typeof DesktopMigrationReceipt.Type) =>
      Schema.encodeUnknownEffect(Schema.fromJsonString(DesktopMigrationReceipt))(value).pipe(
        Effect.flatMap((text) => writeDurably(receiptPath, `${text}\n`)),
      );
    if (!receiptExists) yield* saveReceipt(receipt);
    const before = yield* Effect.tryPromise({
      try: () => fingerprintDatabaseFiles(canonicalDb),
      catch: (cause) => new BootServiceInstallError({ cause }),
    });
    if (receipt.phase === "preparing")
      yield* Effect.tryPromise({
        try: () => backupDatabaseOnce(baseDir, { id: receipt.id, dbPath: canonicalDb }),
        catch: (cause) => new BootServiceInstallError({ cause }),
      });
    const backup = yield* Effect.tryPromise({
      try: () =>
        fingerprintDatabaseFiles(path.join(databaseBackupDir(baseDir, receipt.id), "database")),
      catch: (cause) => new BootServiceInstallError({ cause }),
    });
    const after = yield* Effect.tryPromise({
      try: () => fingerprintDatabaseFiles(canonicalDb),
      catch: (cause) => new BootServiceInstallError({ cause }),
    });
    if (
      !equalMigrationFiles(before, backup) ||
      !equalMigrationFiles(after, backup) ||
      (receipt.phase === "backed-up" &&
        (receipt.files === undefined || !equalMigrationFiles(receipt.files, backup)))
    )
      return yield* new BootServiceInstallError({
        cause: "The database or retained backup changed; migration requires explicit recovery.",
      });
    if (receipt.phase === "preparing")
      yield* saveReceipt({ ...receipt, phase: "backed-up", files: backup });
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(BootServiceInstallError)(cause) ? cause : new BootServiceInstallError({ cause }),
    ),
  );

  const install: BootService["Service"]["install"] = Effect.gen(function* () {
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    // Prepare every immutable artifact before stopping the installed unit.
    yield* ensurePinnedRuntimeInstalled({
      baseDir,
      version: input.cliVersion,
      fs,
      path,
      runner,
      ...(host.bundle === undefined ? {} : { bundle: host.bundle }),
      validate: (runtime) =>
        runner
          .run({
            command:
              host.bundle === undefined ? host.execPath : bundledRuntimeNodePath(runtime.entryPath),
            args: [runtime.entryPath, "--version"],
            // A newly extracted CLI can cold-start slowly on a busy host.
            // Keep verification bounded and finish it before stopping the service.
            timeout: Duration.seconds(90),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({
                  step: "verifying the pinned workjet runtime",
                  cause,
                }),
            ),
            Effect.flatMap((result) => {
              const reportedVersion = /\bv(\S+)\s*$/.exec(result.stdout)?.[1];
              return result.code === 0 && !result.timedOut && reportedVersion === input.cliVersion
                ? Effect.void
                : Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "verifying the pinned workjet runtime",
                      exitCode: Number(result.code),
                      stdoutLength: result.stdout.length,
                      stderrLength: result.stderr.length,
                    }),
                  );
            }),
          ),
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "PinnedRuntimeInstallError"
          ? new BootServiceCommandError({
              step: error.step,
              exitCode: error.exitCode,
              stdoutLength: error.stdoutLength,
              stderrLength: error.stderrLength,
              cause: error,
            })
          : new BootServiceInstallError({ cause: error }),
      ),
    );
    const launcherSource = yield* fs
      .readFileString(launcherSourcePath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    const installed = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (installed) {
      if (host.requireFreshProfile || host.migrateStoppedProfile)
        return yield* new BootServiceInstallError({
          cause: "A service already exists; fresh installation cannot replace or stop it.",
        });
      yield* stopInstalledService;
    }

    yield* Effect.gen(function* () {
      if (host.migrateStoppedProfile) yield* prepareProfileMigration;
      const previousStateText = yield* fs.readFileString(statePath).pipe(Effect.option);
      const previousState = Option.isSome(previousStateText)
        ? parseServiceState(previousStateText.value)
        : undefined;
      const desktop = host.desktop ?? previousState?.desktop;
      if (installed) {
        if (
          Option.isSome(previousStateText) &&
          serviceStateHasPendingUpdate(previousStateText.value)
        ) {
          return yield* new BootServiceUpdatePendingError();
        }
      }
      yield* fs
        .makeDirectory(unitDir, { recursive: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      yield* writeDurably(launcherPath, launcherSource);
      yield* writeDurably(
        statePath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned document.
        `${JSON.stringify(
          {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: input.cliVersion,
            ...(desktop === undefined ? {} : { desktop }),
          } satisfies ServiceState,
          null,
          2,
        )}\n`,
      );
      yield* writeDurably(unitPath, renderUnit());

      if (platform === "linux") {
        yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
        yield* runStep("enabling the service", "systemctl", [
          "--user",
          "enable",
          BOOT_SERVICE_UNIT_FILE,
        ]);
        yield* runStep("enabling lingering for this user", "loginctl", ["enable-linger"]);
      }
    }).pipe(
      (work) => withOwnership("launcher", work),
      (work) =>
        host.requireFreshProfile
          ? withOwnership("runtime", Effect.andThen(requireFreshProfile, work))
          : host.migrateStoppedProfile
            ? withOwnership("runtime", work)
            : work,
      Effect.tapError((error) =>
        installed &&
        !(error._tag === "BootServiceInstallError" && error.cause instanceof ProfileOwnershipError)
          ? startService.pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    // Release mutation exclusion before launching its new lifetime owner.
    // Administration stays serialized until bootstrap returns.
    yield* startService;
    return plan;
  }).pipe(serializeAdministration, Effect.withSpan("cloud.boot_service.install"));

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    if (
      !(yield* fs
        .exists(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))))
    )
      return false;
    if (platform === "darwin") {
      yield* stopInstalledService;
    } else {
      yield* runStep("stopping the service", "systemctl", [
        "--user",
        "disable",
        "--now",
        BOOT_SERVICE_UNIT_FILE,
      ]);
    }
    yield* withOwnership(
      "launcher",
      fs.remove(unitPath).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))),
    );
    if (platform === "linux") {
      yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
    }
    return true;
  }).pipe(serializeAdministration, Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (!supported) {
      return {
        supported: false,
        installed: false,
        current: false,
        unitPath,
        logPath,
        loginSessionOnly,
      };
    }
    if (!(yield* fs.exists(unitPath))) {
      return {
        supported: true,
        installed: false,
        current: false,
        unitPath,
        logPath,
        loginSessionOnly,
      };
    }
    const [unit, launcherExists, runtimeEntryExists, runtimeSentinel, stateText] =
      yield* Effect.all([
        fs.readFileString(unitPath),
        fs.exists(launcherPath),
        fs.exists(runtimePaths.entryPath),
        fs.readFileString(runtimePaths.sentinelPath).pipe(Effect.option),
        fs.readFileString(statePath).pipe(Effect.option),
      ]);
    const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;
    const bundleReceipt =
      host.bundle === undefined
        ? undefined
        : yield* fs
            .readFileString(path.join(runtimePaths.versionDir, BUNDLED_RUNTIME_RECEIPT))
            .pipe(Effect.option);
    const nodeExists = host.bundle === undefined || (yield* fs.exists(plan.nodePath));
    return {
      supported: true,
      installed: true,
      current:
        unit === renderUnit() &&
        launcherExists &&
        runtimeEntryExists &&
        nodeExists &&
        Option.isSome(runtimeSentinel) &&
        runtimeSentinel.value.trim() === input.cliVersion &&
        (host.bundle === undefined ||
          (bundleReceipt !== undefined &&
            Option.isSome(bundleReceipt) &&
            bundleReceipt.value.trim() === host.bundle.sha256)) &&
        state?.activeVersion === input.cliVersion &&
        (host.desktop === undefined ||
          (state?.desktop?.port === host.desktop.port &&
            state.desktop.host === host.desktop.host &&
            state.desktop.tailscaleServeEnabled === host.desktop.tailscaleServeEnabled &&
            state.desktop.tailscaleServePort === host.desktop.tailscaleServePort)) &&
        state?.update?.status !== "pending",
      unitPath,
      logPath,
      loginSessionOnly,
      ...(state?.desktop === undefined ? {} : { desktop: state.desktop }),
    };
  }).pipe(
    Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    Effect.withSpan("cloud.boot_service.status"),
  );

  const start = Effect.gen(function* () {
    const installed = yield* status;
    if (!installed.current)
      return yield* new BootServiceCommandError({
        step: "starting a service whose installed configuration is missing or differs; explicitly install or update it first",
      });
    if (platform === "darwin") {
      // Without -k, kickstart never terminates an already running job. If the
      // label is unloaded, bootstrap the verified unit without rewriting it.
      yield* runStep(
        "starting the installed LaunchAgent",
        "/bin/launchctl",
        ["kickstart", launchTarget],
        { timeout: Duration.seconds(30) },
      ).pipe(Effect.catch(() => startService));
    } else {
      yield* runStep(
        "starting the installed service",
        "systemctl",
        ["--user", "start", BOOT_SERVICE_UNIT_FILE],
        { timeout: Duration.seconds(30) },
      );
    }
  }).pipe(serializeAdministration, Effect.withSpan("cloud.boot_service.start"));
  const stop = Effect.gen(function* () {
    if (
      !(yield* fs
        .exists(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))))
    )
      return false;
    yield* stopInstalledService;
    return true;
  }).pipe(serializeAdministration, Effect.withSpan("cloud.boot_service.stop"));

  return BootService.of({ install, uninstall, status, start, stop });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));
