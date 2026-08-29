for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Socket from "effect/unstable/socket/Socket";
import { RpcSessionFactoryLive } from "@t3tools/client-runtime/rpc";

import * as Electron from "electron";

import * as NetService from "@t3tools/shared/Net";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveRemoteT3CliPackageSpec } from "@t3tools/ssh/command";
import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import serverPackageJson from "../../server/package.json" with { type: "json" };

import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import * as CtoxAppRail from "./ctox/CtoxAppRail.ts";
import * as CtoxBusinessOsShell from "./ctox/CtoxBusinessOsShell.ts";
import * as CtoxDevAuth from "./ctox/CtoxDevAuth.ts";
import * as CtoxDecisionHubProvisioner from "./ctox/CtoxDecisionHubProvisioner.ts";
import * as CtoxElectronSessions from "./ctox/CtoxElectronSessions.ts";
import * as CtoxGuestManager from "./ctox/CtoxGuestManager.ts";
import * as CtoxInstanceRegistry from "./ctox/CtoxInstanceRegistry.ts";
import * as CtoxLocalDaemonLaunch from "./ctox/CtoxLocalDaemonLaunch.ts";
import * as CtoxSshManagedLaunch from "./ctox/CtoxSshManagedLaunch.ts";
import * as CtoxShellFleet from "./ctox/CtoxShellFleet.ts";
import * as CtoxManagedLaunch from "./ctox/CtoxManagedLaunch.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronCrashReporter from "./electron/ElectronCrashReporter.ts";
import * as ElectronDialog from "./electron/ElectronDialog.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronPowerMonitor from "./electron/ElectronPowerMonitor.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "./electron/ElectronSafeStorage.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as ElectronUpdater from "./electron/ElectronUpdater.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopApp from "./app/DesktopApp.ts";
import * as DesktopAppIdentity from "./app/DesktopAppIdentity.ts";
import * as DesktopConnectionCatalogStore from "./app/DesktopConnectionCatalogStore.ts";
import * as DesktopDeepLinkRouter from "./app/DesktopDeepLinkRouter.ts";
import * as DesktopApplicationMenu from "./window/DesktopApplicationMenu.ts";
import * as DesktopAssets from "./app/DesktopAssets.ts";
import * as DesktopBackendConfiguration from "./backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopNetworkInterfaces from "./backend/DesktopNetworkInterfaces.ts";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./app/DesktopLinuxUrlHandler.ts";
import * as DesktopShutdown from "./app/DesktopShutdown.ts";
import * as DesktopObservability from "./app/DesktopObservability.ts";
import * as DesktopServerExposure from "./backend/DesktopServerExposure.ts";
import * as DesktopClientSettings from "./settings/DesktopClientSettings.ts";
import * as DesktopSavedEnvironments from "./settings/DesktopSavedEnvironments.ts";
import * as DesktopAppSettings from "./settings/DesktopAppSettings.ts";
import * as DesktopPreReadyPlatform from "./app/DesktopPreReadyPlatform.ts";
import * as DesktopCrashReporting from "./support/DesktopCrashReporting.ts";
import * as DesktopSupportBundle from "./support/DesktopSupportBundle.ts";
import * as DesktopShellEnvironment from "./shell/DesktopShellEnvironment.ts";
import * as DesktopSshEnvironment from "./ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopComputerProvisioner from "./provisioning/DesktopComputerProvisioner.ts";
import * as DesktopState from "./app/DesktopState.ts";
import * as DesktopUserDataMigration from "./app/DesktopUserDataMigration.ts";
import * as DesktopTelemetryPublisher from "./telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopUpdates from "./updates/DesktopUpdates.ts";
import * as BrowserSession from "./preview/BrowserSession.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";
import * as DesktopWslBackend from "./wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "./wsl/DesktopWslEnvironment.ts";

const desktopEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* Effect.service(ElectronApp.ElectronApp).pipe(
      Effect.flatMap((app) => app.metadata),
    );
    const platform = yield* HostProcessPlatform;
    const processArch = yield* HostProcessArchitecture;
    return DesktopEnvironment.layer({
      dirname: __dirname,
      homeDirectory: NodeOS.homedir(),
      platform,
      processArch,
      ...metadata,
    });
  }),
);

const resolveDesktopSshCliRunner = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  settings: DesktopAppSettings.DesktopSettings,
): RemoteT3RunnerOptions => {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteT3ServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return {
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange: serverPackageJson.engines.node,
    };
  }
  return {
    packageSpec: resolveRemoteT3CliPackageSpec({
      appVersion: environment.appVersion,
      updateChannel: settings.updateChannel,
      isDevelopment: environment.isDevelopment,
    }),
    nodeEngineRange: serverPackageJson.engines.node,
  };
};

const desktopSshEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    return DesktopSshEnvironment.layer({
      resolveCliRunner: settings.get.pipe(
        Effect.map((currentSettings) => resolveDesktopSshCliRunner(environment, currentSettings)),
      ),
    });
  }),
);

const electronLayer = Layer.mergeAll(
  ElectronApp.layer,
  ElectronCrashReporter.layer,
  ElectronDialog.layer,
  ElectronMenu.layer,
  ElectronPowerMonitor.layer,
  ElectronProtocol.layer,
  ElectronSafeStorage.layer,
  ElectronShell.layer,
  ElectronTheme.layer,
  ElectronUpdater.layer,
  ElectronWindow.layer,
  DesktopIpc.layer(Electron.ipcMain),
);

const desktopFoundationLayer = Layer.mergeAll(
  DesktopState.layer,
  DesktopShutdown.layer,
  DesktopAppSettings.layer,
  DesktopClientSettings.layer,
  DesktopConnectionCatalogStore.layer.pipe(Layer.provideMerge(DesktopSavedEnvironments.layer)),
  DesktopAssets.layer,
  DesktopObservability.layer,
).pipe(Layer.provideMerge(desktopEnvironmentLayer));

const desktopSshLayer = desktopSshEnvironmentLayer.pipe(
  Layer.provideMerge(DesktopSshPasswordPrompts.layer()),
);

const desktopServerExposureLayer = DesktopServerExposure.layer.pipe(
  Layer.provideMerge(DesktopNetworkInterfaces.layer),
  Layer.provideMerge(desktopFoundationLayer),
);

const desktopPreviewLayer = PreviewManager.layer.pipe(
  Layer.provideMerge(BrowserSession.layer),
  Layer.provideMerge(desktopFoundationLayer),
);

const desktopWindowLayer = DesktopWindow.layer.pipe(
  Layer.provideMerge(desktopServerExposureLayer),
  Layer.provideMerge(desktopPreviewLayer),
);

// Pool layer instantiates the backend factory once for the Windows
// primary instance and exposes it via pool.primary. Consumers go through
// the pool now; the legacy DesktopBackendManager service is gone. The
// WSL second instance gets registered later in the migration. See
// DesktopBackendPool.ts header for the full rollout plan.
const desktopBackendLayer = DesktopBackendPool.layer.pipe(
  Layer.provideMerge(DesktopAppIdentity.layer),
  Layer.provideMerge(DesktopBackendConfiguration.layer),
  Layer.provideMerge(DesktopWslEnvironment.layer),
  Layer.provideMerge(DesktopTelemetryPublisher.layer),
  Layer.provideMerge(desktopWindowLayer),
);

// WSL orchestrator hangs off the backend layer because it needs the
// pool + configuration + serverExposure; it pulls NetService and the
// foundation services through the same provideMerge chain.
const desktopWslBackendLayer = DesktopWslBackend.layer.pipe(
  Layer.provideMerge(desktopBackendLayer),
);

const desktopLocalEnvironmentAuthLayer = DesktopLocalEnvironmentAuth.layer.pipe(
  Layer.provideMerge(desktopBackendLayer),
);

const desktopRpcSessionLayer = RpcSessionFactoryLive.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
);

// The local-daemon launch service resolves its target through the one
// registry instance, so the registry is provided to (and re-exported by) the
// merged control layer rather than merged beside it.
const desktopCtoxControlLayer = Layer.mergeAll(
  CtoxBusinessOsShell.layer,
  CtoxDevAuth.layer(),
  CtoxAppRail.layer(),
  CtoxManagedLaunch.layer(),
  CtoxLocalDaemonLaunch.layer(),
  CtoxSshManagedLaunch.layer(),
).pipe(
  Layer.provideMerge(
    CtoxInstanceRegistry.layer({
      localDaemon: {
        probe: (url, { signal }) =>
          Electron.net
            .fetch(url, { method: "GET", redirect: "error", signal })
            .then((response) => ({
              ok: response.ok,
            })),
      },
    }),
  ),
  Layer.provideMerge(CtoxElectronSessions.layer),
);

const desktopProvisioningLayer = DesktopComputerProvisioner.layer.pipe(
  // Reuse both the registry and the exact password-prompt instance whose
  // resolve IPC handler lives in desktopSshLayer.
  Layer.provideMerge(desktopSshLayer),
  Layer.provideMerge(desktopCtoxControlLayer),
);

const desktopCtoxLayer = CtoxGuestManager.layer().pipe(Layer.provideMerge(desktopCtoxControlLayer));
const desktopCtoxFleetLayer = CtoxShellFleet.layer().pipe(
  Layer.provideMerge(desktopCtoxControlLayer),
);
const desktopDecisionHubLayer = CtoxDecisionHubProvisioner.layer.pipe(
  Layer.provideMerge(desktopRpcSessionLayer),
  Layer.provideMerge(desktopBackendLayer),
  Layer.provideMerge(desktopCtoxControlLayer),
);

// The support bundle reads the migration decision and the crash-reporter
// state, so it hangs off the same graph the application menu resolves from;
// the menu item and the renderer IPC method share this one instance.
const desktopSupportLayer = DesktopSupportBundle.layer.pipe(
  Layer.provideMerge(DesktopCrashReporting.layer),
);

const desktopApplicationLayer = Layer.mergeAll(
  DesktopLifecycle.layer,
  DesktopApplicationMenu.layer,
  DesktopLinuxUrlHandler.layer,
  DesktopDeepLinkRouter.layer,
  DesktopShellEnvironment.layer,
  desktopCtoxLayer,
  desktopCtoxFleetLayer,
  desktopSshLayer,
  desktopProvisioningLayer,
).pipe(
  // provideMerge, not mergeAll: the application menu resolves the bundle
  // service, and the IPC handler resolves the same instance from the
  // re-exported context.
  Layer.provideMerge(desktopSupportLayer),
  Layer.provideMerge(desktopDecisionHubLayer),
  Layer.provideMerge(DesktopUpdates.layer),
  Layer.provideMerge(desktopWslBackendLayer),
  Layer.provideMerge(desktopLocalEnvironmentAuthLayer),
);

// The migration layer runs any pending legacy user-data import before the
// application opens the profile.
const desktopUserDataMigrationLayer = DesktopUserDataMigration.layer.pipe(
  // The sync FileSystem keeps this construction free of macrotask yields so
  // Keep construction synchronous until the pre-ready application setup.
  Layer.provide(DesktopUserDataMigration.syncFileSystemLayer),
  Layer.provideMerge(desktopEnvironmentLayer),
  Layer.provideMerge(NodeServices.layer),
);

const desktopApplicationRuntimeLayer = desktopApplicationLayer.pipe(
  Layer.provideMerge(desktopUserDataMigrationLayer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(electronLayer),
);

const desktopRuntimeLayer = desktopApplicationRuntimeLayer.pipe(
  Layer.provideMerge(DesktopPreReadyPlatform.layer),
);

DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
