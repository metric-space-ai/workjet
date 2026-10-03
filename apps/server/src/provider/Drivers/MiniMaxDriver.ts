import { MiniMaxSettings, ProviderDriverKind, TextGenerationError, type ServerProvider } from "@workjet/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError, ProviderAdapterRequestError } from "../Errors.ts";
import { makeMiniMaxAdapter } from "../Layers/MiniMaxAdapter.ts";
import { buildInitialMiniMaxProviderSnapshot, checkMiniMaxProviderStatus } from "../Layers/MiniMaxProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver, type ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeProviderMaintenanceCapabilities, resolveProviderMaintenanceCapabilitiesEffect, type ProviderMaintenanceCapabilitiesResolver } from "../providerMaintenance.ts";
import { haveProviderSnapshotSettingsChanged, makeProviderSnapshotSettingsSource, type ProviderSnapshotSettings } from "../providerUpdateSettings.ts";
import { MINIMAX_CODE_RELEASE } from "../minimax/MiniMaxProtocol.ts";

const DRIVER = ProviderDriverKind.make("minimax");
const decode = Schema.decodeSync(MiniMaxSettings);
// Explicit pinned npm install; never run the channel-following mcode updater
// against a profile/executable whose provenance is unknown.
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (options) => makeProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null, updateExecutable: options?.binaryPath?.trim() && options.binaryPath.trim() !== "mcode" ? null : "npm", updateArgs: ["install", "--global", `@minimax-ai/code@${MINIMAX_CODE_RELEASE.version}`, "--registry=https://registry.npmjs.org/", "--include=optional", "--ignore-scripts=false", "--allow-scripts=@minimax-ai/code,better-sqlite3"], updateLockKey: "npm-global" }),
};
export type MiniMaxDriverEnv = ServerConfig | Crypto.Crypto | FileSystem.FileSystem | Path.Path | BackgroundPolicy.BackgroundPolicy | ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService;

export const MiniMaxDriver: ProviderDriver<MiniMaxSettings, MiniMaxDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "MiniMax Code", supportsMultipleInstances: true },
  configSchema: MiniMaxSettings,
  defaultConfig: () => decode({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, routeViaGateway, config }) => Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const serverSettings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;
    const path = yield* Path.Path;
    const probeSessionPath = path.join(serverConfig.providerStatusCacheDir, `minimax-${instanceId}-session.json`);
    const processEnv = mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: DRIVER, instanceId });
    const stamp = (draft: ServerProviderDraft): ServerProvider => ({ ...draft, instanceId, driver: DRIVER, ...(displayName ? { displayName } : {}), ...(accentColor ? { accentColor } : {}), continuation: { groupKey: continuationIdentity.continuationKey } });
    const effective = { ...config, enabled } satisfies MiniMaxSettings;
    const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, { binaryPath: effective.binaryPath, env: processEnv });
    const adapter = yield* makeMiniMaxAdapter(effective, {
      instanceId,
      resolveSessionEnvironment: () => routeViaGateway
        ? Effect.fail(new ProviderAdapterRequestError({ provider: DRIVER, method: "startSession", detail: "MiniMax Code requires an explicitly configured provider route in its selected profile. Workjet gateway injection is not verified for this CLI and cannot silently fall back to direct credentials." }))
        : Effect.succeed(processEnv),
    });
    const unsupported = (operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName" | "generateThreadTitle") => Effect.fail(new TextGenerationError({ operation, detail: "MiniMax Code ACP does not expose this metadata generation operation." }));
    const textGeneration = TextGeneration.of({ generateCommitMessage: () => unsupported("generateCommitMessage"), generatePrContent: () => unsupported("generatePrContent"), generateBranchName: () => unsupported("generateBranchName"), generateThreadTitle: () => unsupported("generateThreadTitle") });
    const source = makeProviderSnapshotSettingsSource(effective, serverSettings);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MiniMaxSettings>>({
      maintenanceCapabilities,
      getSettings: source.getSettings,
      streamSettings: source.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) => buildInitialMiniMaxProviderSnapshot(settings.provider).pipe(Effect.map(stamp)),
      checkProvider: checkMiniMaxProviderStatus(effective, processEnv, probeSessionPath).pipe(Effect.map(stamp), Effect.provideService(Crypto.Crypto, crypto), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.provideService(FileSystem.FileSystem, fs)),
    }).pipe(Effect.mapError((cause) => new ProviderDriverError({ driver: DRIVER, instanceId, detail: `Failed to build MiniMax Code snapshot: ${cause.message}`, cause })));
    return { instanceId, driverKind: DRIVER, continuationIdentity, displayName, accentColor, enabled, snapshot, adapter, textGeneration } satisfies ProviderInstance;
  }),
};
