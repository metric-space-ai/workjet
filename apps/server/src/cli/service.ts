import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Terminal from "effect/Terminal";
import * as Option from "effect/Option";
import { HostProcessExecutablePath } from "@workjet/shared/hostProcess";
import { Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import type * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const bootServiceLayer = (
  config: ServerConfig.ServerConfig["Service"],
  host?: BootService.BootServiceHost,
) =>
  BootService.layer({
    baseDir: config.baseDir,
    logsDir: config.logsDir,
    cliVersion: packageJson.version,
    ...(host === undefined ? {} : { host }),
  }).pipe(Layer.provide(ProcessRunner.layer));

export type ServiceReconcileResult =
  | {
      readonly changed: false;
      readonly status: BootService.BootServiceStatus;
    }
  | {
      readonly changed: true;
      readonly previouslyInstalled: boolean;
      readonly plan: BootService.BootServicePlan;
    };

/** Install, update, or repair the service using the CLI version running this command. */
export const reconcileService = Effect.fn("cli.service.reconcile")(function* () {
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  if (status.installed && status.current) {
    return { changed: false, status } satisfies ServiceReconcileResult;
  }
  const plan = yield* service.install;
  return {
    changed: true,
    previouslyInstalled: status.installed,
    plan,
  } satisfies ServiceReconcileResult;
});

export function formatServiceStatus(
  status: BootService.BootServiceStatus,
  cliVersion: string,
): string {
  if (!status.supported) {
    return "Workjet service\n  Status: unavailable on this machine\n  Supported on: Linux with systemd or macOS with a user login session";
  }
  if (!status.installed) {
    return "Workjet service\n  Status: not installed\n  Next: Run `workjet service install`.";
  }
  return [
    "Workjet service",
    `  Status: ${status.current ? `installed · workjet@${cliVersion}` : "needs an update or repair"}`,
    `  Unit: ${status.unitPath}`,
    `  Logs: ${status.logPath}`,
    ...(status.loginSessionOnly
      ? ["  Lifetime: runs while you are logged in; stops at logout."]
      : []),
    ...(status.current ? [] : ["  Next: Run `npx workjet@latest service update`."]),
  ].join("\n");
}

const runServiceCommand = Effect.fn("cli.service.run")(function* <A, E>(
  flags: {
    readonly baseDir: Parameters<typeof resolveCliAuthConfig>[0]["baseDir"];
    readonly bundleArchive?: Option.Option<string>;
    readonly bundleSha256?: Option.Option<string>;
  },
  run: Effect.Effect<A, E, BootService.BootService>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const archivePath = Option.getOrUndefined(flags.bundleArchive ?? Option.none());
  const sha256 = Option.getOrUndefined(flags.bundleSha256 ?? Option.none());
  if (
    (archivePath === undefined) !== (sha256 === undefined) ||
    (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256))
  ) {
    return yield* new BootService.BootServiceInstallError({
      cause: "Supply both --bundle-archive and a trusted --bundle-sha256.",
    });
  }
  const host =
    archivePath !== undefined && sha256 !== undefined
      ? { execPath: yield* HostProcessExecutablePath, bundle: { archivePath, sha256 } }
      : undefined;
  return yield* run.pipe(Effect.provide(bootServiceLayer(config, host)));
});

const serviceArtifactFlags = {
  ...projectLocationFlags,
  bundleArchive: Flag.string("bundle-archive").pipe(
    Flag.withDescription("Install the trusted portable archive shipped with this Desktop release."),
    Flag.optional,
  ),
  bundleSha256: Flag.string("bundle-sha256").pipe(
    Flag.withDescription("Expected SHA-256 from the trusted Desktop release."),
    Flag.optional,
  ),
};

const serviceInstallCommand = Command.make("install", serviceArtifactFlags).pipe(
  Command.withDescription("Install Workjet as a background service for this user."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const result = yield* reconcileService();
        if (!result.changed) {
          yield* Console.log(
            `Workjet service is already installed with workjet@${packageJson.version}.`,
          );
          return;
        }
        yield* Console.log(
          `${result.previouslyInstalled ? "Updated" : "Installed"} Workjet service with workjet@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
        );
      }),
    ),
  ),
);

const serviceUpdateCommand = Command.make("update", serviceArtifactFlags).pipe(
  Command.withDescription(
    "Update or repair the background service using this CLI version. Use `npx workjet@latest service update` for the latest release.",
  ),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const result = yield* reconcileService();
        if (!result.changed) {
          yield* Console.log(`Workjet service is already using workjet@${packageJson.version}.`);
          return;
        }
        yield* Console.log(
          `${result.previouslyInstalled ? "Updated" : "Installed"} Workjet service with workjet@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
        );
      }),
    ),
  ),
);

const serviceUninstallCommand = Command.make("uninstall", projectLocationFlags).pipe(
  Command.withDescription("Stop and remove the Workjet background service."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        const removed = yield* service.uninstall;
        yield* Console.log(
          removed ? "Removed the Workjet service." : "Workjet service is not installed.",
        );
      }),
    ),
  ),
);

const serviceStatusCommand = Command.make("status", serviceArtifactFlags).pipe(
  Command.withDescription("Show whether the Workjet background service is installed."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        yield* Console.log(formatServiceStatus(yield* service.status, packageJson.version));
      }),
    ),
  ),
);

export const offerServiceDuringOnboarding = Effect.gen(function* () {
  const service = yield* BootService.BootService;
  const { supported, installed, current, loginSessionOnly } = yield* service.status;
  if (!supported) {
    return false;
  }
  if (installed && current) {
    yield* Console.log("Workjet is already set up to run in the background on this machine.");
    return true;
  }
  const wanted = yield* Prompt.run(
    Prompt.confirm({
      message: installed
        ? "The installed Workjet service needs an update or repair. Update it now?"
        : loginSessionOnly
          ? "Run Workjet in the background while you are logged in? It starts at login and stops at logout."
          : "Run Workjet in the background whenever this machine boots? " +
            "It stays reachable through Workjet Connect even after you log out.",
      initial: true,
    }),
  );
  if (!wanted) {
    return false;
  }
  const result = yield* reconcileService();
  if (result.changed) {
    yield* Console.log(
      `Background service ${result.previouslyInstalled ? "updated" : "installed"}. Logs: ${result.plan.logPath}`,
    );
  }
  return true;
});

export const recoverServiceOnboardingOffer = <R>(
  offer: Effect.Effect<boolean, BootService.BootServiceError | Terminal.QuitError, R>,
) =>
  offer.pipe(
    Effect.catchTags({
      QuitError: () => Effect.succeed(false),
      BootServiceUnsupportedError: (error) =>
        Console.log(`Skipping background setup: ${error.message}`).pipe(Effect.as(false)),
      BootServiceCommandError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceInstallError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceUpdatePendingError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
    }),
  );

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the Workjet background service."),
  Command.withSubcommands([
    serviceInstallCommand,
    serviceUninstallCommand,
    serviceUpdateCommand,
    serviceStatusCommand,
  ]),
);
