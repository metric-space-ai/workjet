// @effect-diagnostics nodeBuiltinImport:off - Stable launchd labels hash the canonical profile path.
import { createHash } from "node:crypto";
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
  ProfileOwnershipError,
  type ProfileOwnershipKind,
} from "../profileOwnership.ts";
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
  return `dev.workjet.server.${createHash("sha256").update(canonicalBaseDir).digest("hex")}`;
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
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("workjet/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
  readonly launcherSourcePath?: string;
  readonly bundle?: BundledRuntimeSource;
  readonly desktop?: DesktopServiceLaunchConfig;
}

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
      : runStep("stopping the installed service", "systemctl", [
          "--user",
          "stop",
          BOOT_SERVICE_UNIT_FILE,
        ]);
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
            timeout: Duration.seconds(30),
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
      yield* stopInstalledService;
    }

    yield* Effect.gen(function* () {
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

  return BootService.of({ install, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));
