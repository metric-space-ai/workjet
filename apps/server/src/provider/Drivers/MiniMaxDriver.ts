import {
  resolveWorkjetGatewayModelRoute,
  MiniMaxSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@workjet/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderGatewayService } from "../../providerGateway/ProviderGatewayService.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError, ProviderAdapterRequestError } from "../Errors.ts";
import { makeMiniMaxAdapter } from "../Layers/MiniMaxAdapter.ts";
import {
  buildInitialMiniMaxProviderSnapshot,
  checkMiniMaxProviderStatus,
} from "../Layers/MiniMaxProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { MINIMAX_CODE_RELEASE } from "../minimax/MiniMaxProtocol.ts";
import { miniMaxGatewayProfileConfiguration } from "../minimax/MiniMaxGatewayProfile.ts";

const DRIVER = ProviderDriverKind.make("minimax");
const decode = Schema.decodeSync(MiniMaxSettings);
// Explicit pinned npm install; never run the channel-following mcode updater
// against a profile/executable whose provenance is unknown.
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (options) =>
    makeProviderMaintenanceCapabilities({
      provider: DRIVER,
      packageName: null,
      updateExecutable:
        options?.binaryPath?.trim() && options.binaryPath.trim() !== "mcode" ? null : "npm",
      updateArgs: [
        "install",
        "--global",
        `@minimax-ai/code@${MINIMAX_CODE_RELEASE.version}`,
        "--registry=https://registry.npmjs.org/",
        "--include=optional",
        "--ignore-scripts=false",
        "--allow-scripts=@minimax-ai/code,better-sqlite3",
      ],
      updateLockKey: "npm-global",
    }),
};
export type MiniMaxDriverEnv =
  | ServerConfig
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerSettingsService;

export const MiniMaxDriver: ProviderDriver<MiniMaxSettings, MiniMaxDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "MiniMax Code", supportsMultipleInstances: true },
  configSchema: MiniMaxSettings,
  defaultConfig: () => decode({}),
  create: ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    routeViaGateway,
    config,
  }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const path = yield* Path.Path;
      const probeSessionPath = path.join(
        serverConfig.providerStatusCacheDir,
        `minimax-${instanceId}-session.json`,
      );
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stamp = (draft: ServerProviderDraft): ServerProvider => ({
        ...draft,
        instanceId,
        driver: DRIVER,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const effective = {
        ...config,
        enabled,
        ...(routeViaGateway
          ? { dataDirectory: path.join(serverConfig.stateDir, "harness-gateway-profiles", "minimax", instanceId) }
          : {}),
      } satisfies MiniMaxSettings;
      const gateway = routeViaGateway ? yield* Effect.serviceOption(ProviderGatewayService) : Option.none();
      const profileLock = yield* Semaphore.make(1);
      const resolveSessionEnvironment = (model?: string): Effect.Effect<NodeJS.ProcessEnv, ProviderAdapterRequestError> => routeViaGateway
        ? profileLock.withPermit(Effect.gen(function* () {
            const fail = (detail: string) => new ProviderAdapterRequestError({ provider: DRIVER, method: "startSession", detail });
            if (Option.isNone(gateway)) return yield* fail("The Workjet provider gateway service is unavailable.");
            const status = yield* gateway.value.status();
            if (status.phase !== "ready" || !status.providerEndpoint) return yield* fail(`Start the Workjet provider gateway before using MiniMax Code (${status.phase}).`);
            const catalog = yield* gateway.value.catalog().pipe(Effect.mapError(cause => fail(`The Workjet gateway catalog could not be read (${cause.reason}).`)));
            const selected = model ?? catalog.models.find(entry => resolveWorkjetGatewayModelRoute({ catalog, model: entry.id }).outcome === "resolved")?.id;
            if (!selected) return yield* fail("Connect a real model account to the Workjet gateway.");
            const profile = yield* Effect.try({
              try: () => miniMaxGatewayProfileConfiguration(status.providerEndpoint!, catalog, selected),
              catch: cause => fail(cause instanceof Error ? cause.message : "The selected gateway model is unavailable."),
            });
            // This directory is reserved for this gateway instance. Native profiles and
            // their saved sessions never receive placeholder credentials or new defaults.
            yield* fs.makeDirectory(effective.dataDirectory, { recursive: true }).pipe(Effect.mapError(() => fail("The MiniMax gateway profile could not be created.")));
            const staged = path.join(effective.dataDirectory, ".workjet-config.json");
            const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(profile).pipe(Effect.mapError(() => fail("The MiniMax gateway profile could not be encoded.")));
            yield* fs.writeFileString(staged, encoded).pipe(Effect.andThen(fs.rename(staged, path.join(effective.dataDirectory, "config.yaml"))), Effect.mapError(() => fail("The MiniMax gateway profile could not be written.")));
            return { ...processEnv, MINIMAX_DATA_DIR: effective.dataDirectory };
          }))
        : Effect.succeed(processEnv);
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effective.binaryPath,
        env: processEnv,
      });
      const adapter = yield* makeMiniMaxAdapter(effective, {
        instanceId,
        resolveSessionEnvironment,
      });
      const unsupported = (
        operation:
          | "generateCommitMessage"
          | "generatePrContent"
          | "generateBranchName"
          | "generateThreadTitle",
      ) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "MiniMax Code ACP does not expose this metadata generation operation.",
          }),
        );
      const textGeneration = TextGeneration.of({
        generateCommitMessage: () => unsupported("generateCommitMessage"),
        generatePrContent: () => unsupported("generatePrContent"),
        generateBranchName: () => unsupported("generateBranchName"),
        generateThreadTitle: () => unsupported("generateThreadTitle"),
      });
      const source = makeProviderSnapshotSettingsSource(effective, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MiniMaxSettings>>({
        maintenanceCapabilities,
        getSettings: source.getSettings,
        streamSettings: source.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialMiniMaxProviderSnapshot(settings.provider).pipe(Effect.map(stamp)),
        checkProvider: resolveSessionEnvironment().pipe(
          Effect.flatMap(env => checkMiniMaxProviderStatus(
              effective,
              env,
              probeSessionPath,
              serverConfig.providerStatusCacheDir,
            )),
          Effect.catch(cause => buildInitialMiniMaxProviderSnapshot(effective).pipe(Effect.map(draft => ({ ...draft, status: "error" as const, message: cause.message })))),
          Effect.map(stamp),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: `Failed to build MiniMax Code snapshot: ${cause.message}`,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
