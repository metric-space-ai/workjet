import { PiSettings, ProviderDriverKind, TextGenerationError, resolveWorkjetGatewayModelRoute, type ServerProvider } from "@workjet/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderGatewayService } from "../../providerGateway/ProviderGatewayService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError, ProviderAdapterRequestError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver, type ProviderInstance } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { buildServerProvider, parseGenericCliVersion, spawnAndCollect, type ProviderProbeResult } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { haveProviderSnapshotSettingsChanged, makeProviderSnapshotSettingsSource, type ProviderSnapshotSettings } from "../providerUpdateSettings.ts";
import { PI_WORKJET_EXTENSION } from "../pi/PiWorkjetExtension.ts";
import { piGatewayConfiguration, piGatewayModel } from "../pi/PiGatewayProfile.ts";


const DRIVER = ProviderDriverKind.make("pi");
export type PiDriverEnv = ServerConfig | FileSystem.FileSystem | Path.Path | ProviderGatewayService | ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService | BackgroundPolicy.BackgroundPolicy;

/** Explicit instances only: no legacy Pi mirror or default supervisor selection is introduced. */
export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER, metadata: { displayName: "Pi Code", supportsMultipleInstances: true }, configSchema: PiSettings,
  defaultConfig: () => Schema.decodeSync(PiSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, routeViaGateway, config }) => Effect.gen(function* () {
    const server = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gateway = yield* ProviderGatewayService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const settings = yield* ServerSettingsService;
    const effective = { ...config, enabled };
    const agentDirectory = path.join(server.stateDir, "harness-gateway-profiles", "pi", instanceId);
    const sessionDirectory = path.join(agentDirectory, "sessions");
    const processEnv = mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: DRIVER, instanceId });
    const fail = (detail: string) => new ProviderAdapterRequestError({ provider: DRIVER, method: "gateway", detail });
    const profileLock = yield* Semaphore.make(1);
    const resolveModel = Effect.fn("Pi.gatewayModel")(function* (model: string) {
      if (!routeViaGateway) return yield* fail("Enable Workjet gateway routing for this Pi Code instance.");
      const status = yield* gateway.status();
      if (status.phase !== "ready" || !status.providerEndpoint) return yield* fail("Start the Workjet gateway before using Pi Code.");
      const endpoint = status.providerEndpoint;
      const catalog = yield* gateway.catalog().pipe(Effect.mapError(cause => fail(cause.message)));
      const selected = yield* Effect.try({ try: () => piGatewayModel(catalog, model), catch: cause => fail(String(cause)) });
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(piGatewayConfiguration(endpoint, catalog)).pipe(Effect.mapError(cause => fail(cause.message)));
      yield* fs.makeDirectory(sessionDirectory, { recursive: true }).pipe(Effect.mapError(cause => fail(cause.message)));
      yield* profileLock.withPermit(Effect.gen(function* () {
        for (const [filename, content] of [["models.json", encoded], ["workjet-extension.mjs", PI_WORKJET_EXTENSION]] as const) {
          const staged = path.join(agentDirectory, `${filename}.workjet-stage`);
          yield* fs.writeFileString(staged, content).pipe(Effect.andThen(fs.rename(staged, path.join(agentDirectory, filename))), Effect.mapError(cause => fail(cause.message)));
        }
      }));
      return { ...selected, environment: { ...processEnv, PI_CODING_AGENT_DIR: agentDirectory } };
    });
    const adapter = yield* makePiAdapter({ instanceId, binaryPath: config.binaryPath, enabled, sessionDirectory, extensionPath: path.join(agentDirectory, "workjet-extension.mjs"), resolveModel });
    const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null });
    const buildSnapshot = Effect.fn("Pi.snapshot")(function* (probe: ProviderProbeResult) {
      const catalog = yield* gateway.catalog().pipe(Effect.orElseSucceed(() => null));
      const models = routeViaGateway && catalog ? catalog.models.filter(model => resolveWorkjetGatewayModelRoute({ catalog, model: model.id }).outcome === "resolved").map(model => ({ slug: model.id, name: model.displayName, isCustom: true, capabilities: {} })) : [];
      const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      return { ...buildServerProvider({ presentation: { displayName: displayName ?? "Pi Code" }, enabled, checkedAt, models, probe }), instanceId, driver: DRIVER, continuation: { groupKey: continuationIdentity.continuationKey }, ...(accentColor ? { accentColor } : {}) } satisfies ServerProvider;
    });
    const pending = () => buildSnapshot({ installed: false, version: null, status: "warning", auth: { status: "unknown" }, message: "Checking Pi Code." });
    const check = Effect.gen(function* () {
      const result = yield* spawnAndCollect(config.binaryPath, ChildProcess.make(config.binaryPath, ["--version"], { env: processEnv, extendEnv: true })).pipe(Effect.timeout("4 seconds"), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const status = yield* gateway.status();
      return yield* buildSnapshot({ installed: result.code === 0, version: parseGenericCliVersion(result.stdout), status: result.code === 0 && routeViaGateway && status.phase === "ready" ? "ready" : "warning", auth: { status: "unknown", type: "gateway", label: "Workjet gateway" }, ...(result.code !== 0 ? { message: "Pi Code could not be executed." } : !routeViaGateway ? { message: "Enable Workjet gateway routing." } : status.phase !== "ready" ? { message: "Start the Workjet gateway." } : {}) });
    }).pipe(Effect.catch(cause => buildSnapshot({ installed: false, version: null, status: "error", auth: { status: "unknown" }, message: cause.message })));
    const source = makeProviderSnapshotSettingsSource(effective, settings);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({ maintenanceCapabilities, getSettings: source.getSettings, streamSettings: source.streamSettings, haveSettingsChanged: haveProviderSnapshotSettingsChanged, initialSnapshot: pending, checkProvider: check }).pipe(Effect.mapError(cause => new ProviderDriverError({ driver: DRIVER, instanceId, detail: cause.message, cause })));
    const unsupported = (operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName" | "generateThreadTitle") => Effect.fail(new TextGenerationError({ operation, detail: "Pi Code RPC does not expose Workjet metadata generation." }));
    return { instanceId, driverKind: DRIVER, continuationIdentity, displayName, accentColor, enabled, adapter, snapshot, textGeneration: { generateCommitMessage: () => unsupported("generateCommitMessage"), generatePrContent: () => unsupported("generatePrContent"), generateBranchName: () => unsupported("generateBranchName"), generateThreadTitle: () => unsupported("generateThreadTitle") } } satisfies ProviderInstance;
  }),
};
