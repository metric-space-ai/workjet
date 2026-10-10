import { GreppySettings, ProviderDriverKind, type ServerProvider } from "@workjet/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeGreppyTextGeneration } from "../../textGeneration/GreppyTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGreppyAdapter } from "../Layers/GreppyAdapter.ts";
import {
  buildInitialGreppyProviderSnapshot,
  checkGreppyProviderStatus,
} from "../Layers/GreppyProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { ProviderGatewayService } from "../../providerGateway/ProviderGatewayService.ts";
import { resolveGatewayRoutedEnvironment } from "../ProviderGatewayRouting.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeGreppySettings = Schema.decodeSync(GreppySettings);
const DRIVER_KIND = ProviderDriverKind.make("greppy");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type GreppyDriverEnv =
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderGatewayService
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const GreppyDriver: ProviderDriver<GreppySettings, GreppyDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Greppy",
    supportsMultipleInstances: true,
  },
  configSchema: GreppySettings,
  defaultConfig: (): GreppySettings => decodeGreppySettings({}),
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
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies GreppySettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const gateway = yield* ProviderGatewayService;
      const resolveSessionEnvironment = (model?: string) =>
        resolveGatewayRoutedEnvironment({
          driver: DRIVER_KIND,
          instanceId,
          routeViaGateway,
          environment,
          ...(model === undefined || model.length === 0 ? {} : { model }),
        }).pipe(Effect.provideService(ProviderGatewayService, gateway));

      const adapter = yield* makeGreppyAdapter(effectiveConfig, {
        instanceId,
        resolveSessionEnvironment,
        dispatchPromptInBackground: routeViaGateway,
      });
      const textGeneration = yield* makeGreppyTextGeneration;
      const checkProvider = checkGreppyProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GreppySettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialGreppyProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkProvider.pipe(Effect.map(stampIdentity)),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Greppy snapshot: ${cause.message}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
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
