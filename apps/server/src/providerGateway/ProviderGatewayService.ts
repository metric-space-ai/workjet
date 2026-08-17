import {
  WorkjetGatewayOperationError,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayFailureReason,
  type WorkjetGatewayStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  accountSecretReferences,
  decodeProviderGatewayConfiguration,
  GATEWAY_SECRET_SCOPE,
  gatewayCatalog,
  MANAGEMENT_SECRET_NAME,
  rustHostConfiguration,
  secretStoreName,
  type GatewaySecretReference,
  type ProviderGatewayConfiguration,
} from "./ProviderGatewayConfig.ts";
import { nodeProviderGatewayPlatform } from "./ProviderGatewayNodeAdapter.ts";

const CONFIG_MAX_BYTES = 256 * 1024;
const READINESS_MAX_BYTES = 4 * 1024;
const PROCESS_OUTPUT_MAX_BYTES = 64 * 1024;
const MANAGEMENT_MAX_BYTES = 64 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

interface GatewayReadiness {
  readonly schema: "workjet.provider-gateway-host.readiness.v1";
  readonly pid: number;
  readonly providerEndpoint: string;
  readonly managementEndpoint: string;
  readonly phase: "ready";
}

export interface GatewayProcessExit {
  readonly code: number | null;
  readonly signal: "SIGTERM" | "SIGKILL" | string | null;
}

export interface GatewayHostProcess {
  readonly pid: number;
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  readonly exit: Promise<GatewayProcessExit>;
  readonly kill: (signal: "SIGTERM" | "SIGKILL") => boolean;
}

export interface ProviderGatewayPlatform {
  readonly joinPath: (...parts: ReadonlyArray<string>) => string;
  readonly defaultExecutable: (stateDir: string) => string;
  readonly byteLength: (value: Uint8Array | string) => number;
  readonly chunkText: (value: Uint8Array | string) => string;
  readonly bytesToHex: (value: Uint8Array) => string;
  readonly withTimeout: <A>(
    promise: Promise<A>,
    timeoutMs: number,
    onTimeout: () => void,
  ) => Promise<A>;
  readonly readText: (path: string, maximumBytes: number) => Promise<string>;
  readonly writePrivateText: (path: string, content: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly spawn: (executable: string, args: ReadonlyArray<string>) => GatewayHostProcess;
  readonly managementGet: (
    endpoint: string,
    route: string,
    key: string,
    maximumBytes: number,
  ) => Promise<unknown>;
}

export interface ProviderGatewayServiceShape {
  readonly status: () => Effect.Effect<WorkjetGatewayStatus>;
  readonly catalog: () => Effect.Effect<WorkjetGatewayCatalog, WorkjetGatewayOperationError>;
  readonly start: () => Effect.Effect<WorkjetGatewayStatus, WorkjetGatewayOperationError>;
  readonly stop: () => Effect.Effect<WorkjetGatewayStatus, WorkjetGatewayOperationError>;
}

export class ProviderGatewayService extends Context.Service<
  ProviderGatewayService,
  ProviderGatewayServiceShape
>()("t3/providerGateway/ProviderGatewayService") {}

export interface ProviderGatewayServiceOptions {
  readonly platform?: ProviderGatewayPlatform;
  readonly executable?: string;
  readonly configurationPath?: string;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

const safeError = (reason: WorkjetGatewayFailureReason) =>
  new WorkjetGatewayOperationError({ reason });
const isGatewayOperationError = Schema.is(WorkjetGatewayOperationError);

const emptyStatus = (): WorkjetGatewayStatus => ({
  schemaVersion: 1,
  phase: "stopped",
  pid: null,
  providerEndpoint: null,
  managementEndpoint: null,
  failureReason: null,
  configuredAccountCount: 0,
  configuredModelCount: 0,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isLoopbackHttpEndpoint = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 256) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      Number(url.port) > 0
    );
  } catch {
    return false;
  }
};

const decodeReadiness = (value: string, expectedPid: number): GatewayReadiness | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.schema !== "workjet.provider-gateway-host.readiness.v1" ||
    parsed.pid !== expectedPid ||
    parsed.phase !== "ready" ||
    !isLoopbackHttpEndpoint(parsed.providerEndpoint) ||
    !isLoopbackHttpEndpoint(parsed.managementEndpoint)
  ) {
    return undefined;
  }
  return parsed as unknown as GatewayReadiness;
};

const allSecretReferences = (
  configuration: ProviderGatewayConfiguration,
): ReadonlyArray<GatewaySecretReference> => [
  ...configuration.accounts.flatMap(accountSecretReferences),
  ...(configuration.antigravityOauth
    ? [
        configuration.antigravityOauth.clientIdSecret,
        configuration.antigravityOauth.clientSecretSecret,
      ]
    : []),
];

const consumeStderr = async (
  hostProcess: GatewayHostProcess,
  platform: ProviderGatewayPlatform,
): Promise<void> => {
  let bytes = 0;
  for await (const chunk of hostProcess.stderr) {
    bytes += platform.byteLength(chunk);
    if (bytes > PROCESS_OUTPUT_MAX_BYTES) {
      hostProcess.kill("SIGKILL");
      return;
    }
  }
};

const readinessLine = (
  hostProcess: GatewayHostProcess,
  platform: ProviderGatewayPlatform,
  onProtocolViolation: () => void,
): Promise<string> =>
  new Promise((resolve, reject) => {
    void (async () => {
      let bytes = 0;
      let buffered = "";
      let settled = false;
      try {
        for await (const chunk of hostProcess.stdout) {
          bytes += platform.byteLength(chunk);
          if (bytes > READINESS_MAX_BYTES) throw new Error("oversized readiness");
          buffered += platform.chunkText(chunk);
          const newline = buffered.indexOf("\n");
          if (!settled && newline >= 0) {
            const line = buffered.slice(0, newline);
            const remainder = buffered.slice(newline + 1);
            if (remainder.trim() !== "") throw new Error("extra output");
            settled = true;
            resolve(line);
            buffered = "";
          } else if (settled && buffered.trim() !== "") {
            onProtocolViolation();
            return;
          }
        }
        if (!settled) reject(new Error("missing readiness"));
      } catch (error) {
        if (settled) onProtocolViolation();
        else reject(error);
      }
    })();
  });

const waitForExit = async (
  hostProcess: GatewayHostProcess,
  platform: ProviderGatewayPlatform,
  timeoutMs: number,
): Promise<boolean> => {
  try {
    await platform.withTimeout(hostProcess.exit, timeoutMs, () => undefined);
    return true;
  } catch {
    return false;
  }
};

export const make = (options: ProviderGatewayServiceOptions = {}) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const secrets = yield* ServerSecretStore;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const platform = options.platform ?? nodeProviderGatewayPlatform;
    const configurationPath =
      options.configurationPath ??
      platform.joinPath(serverConfig.stateDir, "provider-gateway.json");
    const hostConfigurationPath = platform.joinPath(
      serverConfig.stateDir,
      "provider-gateway-runtime.json",
    );
    const executable = options.executable ?? platform.defaultExecutable(serverConfig.stateDir);
    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

    let currentStatus = emptyStatus();
    let currentCatalog: WorkjetGatewayCatalog = {
      schemaVersion: 1,
      accounts: [],
      pools: [],
      routes: [],
      models: [],
    };
    let hostProcess: GatewayHostProcess | undefined;
    let managementCredential: string | undefined;
    let startFlight: Promise<WorkjetGatewayStatus> | undefined;
    let stopFlight: Promise<WorkjetGatewayStatus> | undefined;

    const failStatus = (reason: WorkjetGatewayFailureReason): WorkjetGatewayStatus => {
      currentStatus = {
        ...currentStatus,
        phase: "faulted",
        pid: null,
        providerEndpoint: null,
        managementEndpoint: null,
        failureReason: reason,
      };
      return currentStatus;
    };

    const loadConfiguration = async (): Promise<ProviderGatewayConfiguration> => {
      let raw: string;
      try {
        raw = await platform.readText(configurationPath, CONFIG_MAX_BYTES);
      } catch {
        throw safeError("invalid-configuration");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw safeError("invalid-configuration");
      }
      const configuration = decodeProviderGatewayConfiguration(parsed);
      if (configuration === undefined) throw safeError("invalid-configuration");
      return configuration;
    };

    const assertSecrets = async (configuration: ProviderGatewayConfiguration): Promise<void> => {
      const references = allSecretReferences(configuration);
      for (const reference of references) {
        const value = await runPromise(secrets.get(secretStoreName(reference))).catch(() => {
          throw safeError("secret-unavailable");
        });
        if (Option.isNone(value) || value.value.byteLength === 0) {
          throw safeError("secret-unavailable");
        }
      }
    };

    const checkManagement = async (readiness: GatewayReadiness, key: string): Promise<void> => {
      try {
        const [status, configuration] = await Promise.all([
          platform.managementGet(
            readiness.managementEndpoint,
            "/v0/management/runtime-status",
            key,
            MANAGEMENT_MAX_BYTES,
          ),
          platform.managementGet(
            readiness.managementEndpoint,
            "/v0/management/runtime-config",
            key,
            MANAGEMENT_MAX_BYTES,
          ),
        ]);
        if (
          !isRecord(status) ||
          status.schema !== "workjet.provider-gateway.runtime-status.v1" ||
          !isRecord(configuration) ||
          configuration.schema !== "workjet.provider-gateway.runtime-summary.v1"
        ) {
          throw new Error("invalid management response");
        }
      } catch {
        throw safeError("management-unavailable");
      }
    };

    const terminate = async (target: GatewayHostProcess): Promise<boolean> => {
      target.kill("SIGTERM");
      if (await waitForExit(target, platform, shutdownTimeoutMs)) return true;
      target.kill("SIGKILL");
      return waitForExit(target, platform, shutdownTimeoutMs);
    };

    const runStart = async (): Promise<WorkjetGatewayStatus> => {
      if (currentStatus.phase === "ready") return currentStatus;
      if (stopFlight !== undefined) await stopFlight;
      const configuration = await loadConfiguration();
      currentCatalog = gatewayCatalog(configuration);
      currentStatus = {
        schemaVersion: 1,
        phase: "starting",
        pid: null,
        providerEndpoint: null,
        managementEndpoint: null,
        failureReason: null,
        configuredAccountCount: currentCatalog.accounts.length,
        configuredModelCount: currentCatalog.models.length,
      };
      try {
        await assertSecrets(configuration);
      } catch (error) {
        failStatus("secret-unavailable");
        throw error;
      }
      let keyBytes: Uint8Array;
      try {
        keyBytes = await runPromise(
          secrets.getOrCreateRandom(`${GATEWAY_SECRET_SCOPE}.${MANAGEMENT_SECRET_NAME}`, 32),
        );
      } catch {
        failStatus("secret-unavailable");
        throw safeError("secret-unavailable");
      }
      if (keyBytes.byteLength < 32) {
        failStatus("secret-unavailable");
        throw safeError("secret-unavailable");
      }
      const key = platform.bytesToHex(keyBytes);
      try {
        await platform.writePrivateText(
          hostConfigurationPath,
          JSON.stringify(rustHostConfiguration(configuration, serverConfig.secretsDir)),
        );
      } catch {
        failStatus("host-unavailable");
        throw safeError("host-unavailable");
      }
      let child: GatewayHostProcess;
      try {
        child = platform.spawn(executable, ["--config", hostConfigurationPath]);
      } catch {
        await platform.remove(hostConfigurationPath).catch(() => undefined);
        failStatus("host-unavailable");
        throw safeError("host-unavailable");
      }
      hostProcess = child;
      currentStatus = { ...currentStatus, pid: child.pid };
      void consumeStderr(child, platform);
      const linePromise = readinessLine(child, platform, () => {
        if (hostProcess === child) {
          child.kill("SIGKILL");
          failStatus("invalid-readiness");
        }
      });
      let line: string;
      let startupTimedOut = false;
      try {
        line = await platform.withTimeout(
          Promise.race([
            linePromise,
            child.exit.then(() => {
              throw safeError("process-exit");
            }),
          ]),
          startupTimeoutMs,
          () => {
            startupTimedOut = true;
            child.kill("SIGTERM");
          },
        );
      } catch (error) {
        const reason = isGatewayOperationError(error)
          ? error.reason
          : startupTimedOut
            ? "startup-timeout"
            : currentStatus.phase === "faulted"
              ? (currentStatus.failureReason ?? "invalid-readiness")
              : "invalid-readiness";
        await terminate(child);
        await platform.remove(hostConfigurationPath).catch(() => undefined);
        if (hostProcess === child) hostProcess = undefined;
        failStatus(reason);
        throw safeError(reason);
      }
      const readiness = decodeReadiness(line, child.pid);
      if (readiness === undefined) {
        await terminate(child);
        await platform.remove(hostConfigurationPath).catch(() => undefined);
        if (hostProcess === child) hostProcess = undefined;
        failStatus("invalid-readiness");
        throw safeError("invalid-readiness");
      }
      try {
        await checkManagement(readiness, key);
      } catch {
        await terminate(child);
        await platform.remove(hostConfigurationPath).catch(() => undefined);
        if (hostProcess === child) hostProcess = undefined;
        failStatus("management-unavailable");
        throw safeError("management-unavailable");
      }
      await platform.remove(hostConfigurationPath).catch(() => undefined);
      managementCredential = key;
      currentStatus = {
        ...currentStatus,
        phase: "ready",
        providerEndpoint: readiness.providerEndpoint,
        managementEndpoint: readiness.managementEndpoint,
        failureReason: null,
      };
      void child.exit.then(() => {
        if (hostProcess === child) {
          hostProcess = undefined;
          managementCredential = undefined;
          if (currentStatus.phase !== "stopping" && currentStatus.phase !== "stopped") {
            failStatus("process-exit");
          }
        }
      });
      return currentStatus;
    };

    const startSingleFlight = (): Promise<WorkjetGatewayStatus> => {
      if (startFlight !== undefined) return startFlight;
      const flight = runStart().finally(() => {
        if (startFlight === flight) startFlight = undefined;
      });
      startFlight = flight;
      return flight;
    };

    const runStop = async (): Promise<WorkjetGatewayStatus> => {
      if (
        currentStatus.phase === "stopped" &&
        hostProcess === undefined &&
        startFlight === undefined
      ) {
        return currentStatus;
      }
      if (startFlight !== undefined) {
        await startFlight.catch(() => undefined);
      }
      const child = hostProcess;
      if (child === undefined) {
        currentStatus = {
          ...currentStatus,
          phase: "stopped",
          pid: null,
          providerEndpoint: null,
          managementEndpoint: null,
          failureReason: null,
        };
        managementCredential = undefined;
        await platform.remove(hostConfigurationPath).catch(() => undefined);
        return currentStatus;
      }
      currentStatus = { ...currentStatus, phase: "stopping", failureReason: null };
      const stopped = await terminate(child);
      if (!stopped) {
        failStatus("shutdown-timeout");
        throw safeError("shutdown-timeout");
      }
      if (hostProcess === child) hostProcess = undefined;
      managementCredential = undefined;
      currentStatus = {
        ...currentStatus,
        phase: "stopped",
        pid: null,
        providerEndpoint: null,
        managementEndpoint: null,
        failureReason: null,
      };
      await platform.remove(hostConfigurationPath).catch(() => undefined);
      return currentStatus;
    };

    const stopSingleFlight = (): Promise<WorkjetGatewayStatus> => {
      if (stopFlight !== undefined) return stopFlight;
      // Interrupt a host that is still negotiating readiness instead of making
      // shutdown wait for the full startup deadline.
      if (startFlight !== undefined && hostProcess !== undefined) hostProcess.kill("SIGTERM");
      const flight = runStop().finally(() => {
        if (stopFlight === flight) stopFlight = undefined;
      });
      stopFlight = flight;
      return flight;
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        stopSingleFlight().then(
          () => undefined,
          () => undefined,
        ),
      ),
    );

    return ProviderGatewayService.of({
      status: () => Effect.sync(() => currentStatus),
      catalog: () =>
        Effect.tryPromise({
          try: async () => {
            if (
              currentStatus.phase === "ready" &&
              currentStatus.managementEndpoint !== null &&
              managementCredential !== undefined
            ) {
              try {
                const response = await platform.managementGet(
                  currentStatus.managementEndpoint,
                  "/v0/management/runtime-config",
                  managementCredential,
                  MANAGEMENT_MAX_BYTES,
                );
                if (
                  !isRecord(response) ||
                  response.schema !== "workjet.provider-gateway.runtime-summary.v1"
                ) {
                  throw new Error("invalid management response");
                }
              } catch {
                throw safeError("management-unavailable");
              }
              return currentCatalog;
            }
            const configuration = await loadConfiguration();
            currentCatalog = gatewayCatalog(configuration);
            return currentCatalog;
          },
          catch: (error) =>
            isGatewayOperationError(error) ? error : safeError("invalid-configuration"),
        }),
      start: () =>
        Effect.tryPromise({
          try: startSingleFlight,
          catch: (error) =>
            isGatewayOperationError(error) ? error : safeError("host-unavailable"),
        }),
      stop: () =>
        Effect.tryPromise({
          try: stopSingleFlight,
          catch: (error) =>
            isGatewayOperationError(error) ? error : safeError("shutdown-timeout"),
        }),
    });
  });

export const layerWithOptions = (options?: ProviderGatewayServiceOptions) =>
  Layer.effect(ProviderGatewayService, make(options));

export const layer = layerWithOptions();
