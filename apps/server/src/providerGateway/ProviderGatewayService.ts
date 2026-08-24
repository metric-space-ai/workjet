import {
  WORKJET_GATEWAY_DEFAULT_ROUTING_STRATEGY,
  WorkjetGatewayAccountId,
  WorkjetGatewayOperationError,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayDiscoveredModel,
  type WorkjetGatewayFailureReason,
  type WorkjetGatewayHealth,
  type WorkjetGatewayModelDiscovery,
  type WorkjetGatewayOauthPollInput,
  type WorkjetGatewayOauthPollResult,
  type WorkjetGatewayOauthSession,
  type WorkjetGatewayAddApiKeyAccountInput,
  type WorkjetGatewayAddApiKeyAccountResult,
  type WorkjetGatewayOauthProvider,
  type WorkjetGatewayOauthStartInput,
  type WorkjetGatewayProvider,
  type WorkjetGatewayProviderHealth,
  type WorkjetGatewayProviderModels,
  type WorkjetGatewayProviderPhase,
  type WorkjetGatewayStatus,
  type WorkjetGatewayUpdateRoutingInput,
  type WorkjetGatewayUpdateRoutingResult,
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
  credentialSuffix,
  decodeProviderGatewayConfiguration,
  GATEWAY_SECRET_SCOPE,
  gatewayCatalog,
  isAcceptableApiKey,
  MANAGEMENT_SECRET_NAME,
  rustHostConfiguration,
  secretStoreName,
  type GatewayAccount,
  type GatewaySecretReference,
  type ProviderGatewayConfiguration,
} from "./ProviderGatewayConfig.ts";
import {
  GATEWAY_MODEL_CHANNELS,
  decodeModelDefinitions,
  decodeRuntimeConfigSummary,
  decodeRuntimeStatus,
} from "./ProviderGatewayManagement.ts";
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
  /** Management call with an explicit method; returns null for an empty body. */
  readonly managementRequest: (
    endpoint: string,
    route: string,
    key: string,
    method: "GET" | "POST" | "DELETE",
    maximumBytes: number,
  ) => Promise<unknown>;
  /** Reserve a currently free loopback TCP port for the stable provider endpoint. */
  readonly allocateLoopbackPort: () => Promise<number>;
  /**
   * Signal an arbitrary pid; `"probe"` tests existence without a signal.
   * Returns false when no such process exists (or it cannot be signalled).
   */
  readonly signalProcess: (pid: number, signal: "SIGTERM" | "SIGKILL" | "probe") => boolean;
  /** Bounded sleep used while waiting for a stale host to exit. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Wall clock, injected so a health snapshot's age is testable. */
  readonly now: () => number;
}

export interface ProviderGatewayServiceShape {
  readonly status: () => Effect.Effect<WorkjetGatewayStatus>;
  readonly catalog: () => Effect.Effect<WorkjetGatewayCatalog, WorkjetGatewayOperationError>;
  readonly start: () => Effect.Effect<WorkjetGatewayStatus, WorkjetGatewayOperationError>;
  readonly stop: () => Effect.Effect<WorkjetGatewayStatus, WorkjetGatewayOperationError>;
  /** Begin a provider OAuth login; the user opens the returned URL themselves. */
  readonly oauthStart: (
    input: WorkjetGatewayOauthStartInput,
  ) => Effect.Effect<WorkjetGatewayOauthSession, WorkjetGatewayOperationError>;
  /**
   * Poll a login session. On completion this claims the one-time credentials
   * from the host, persists them into the server secret store plus the gateway
   * configuration, and restarts the gateway; token material never reaches the
   * renderer.
   */
  readonly oauthPoll: (
    input: WorkjetGatewayOauthPollInput,
  ) => Effect.Effect<WorkjetGatewayOauthPollResult, WorkjetGatewayOperationError>;
  readonly oauthCancel: (
    input: WorkjetGatewayOauthPollInput,
  ) => Effect.Effect<void, WorkjetGatewayOperationError>;
  /**
   * Add an API-key provider account. The key is written to the server secret
   * store and only a secret REFERENCE is persisted in the gateway
   * configuration; the key is never logged and never returned.
   */
  readonly addApiKeyAccount: (
    input: WorkjetGatewayAddApiKeyAccountInput,
  ) => Effect.Effect<WorkjetGatewayAddApiKeyAccountResult, WorkjetGatewayOperationError>;
  /**
   * Health as the RUNNING host reports it. Everything here is read from the
   * host's management surface; the dimensions the host does not publish are
   * reported as unavailable rather than filled in from configuration.
   */
  readonly health: () => Effect.Effect<WorkjetGatewayHealth, WorkjetGatewayOperationError>;
  /**
   * Models the host's own catalog serves per provider, merged with the models
   * recorded on the accounts. The host performs no upstream capability query,
   * so every entry is labelled with where it came from.
   */
  readonly discoverModels: () => Effect.Effect<
    WorkjetGatewayModelDiscovery,
    WorkjetGatewayOperationError
  >;
  /** Edits the host-wide selection strategy and per-account pool membership. */
  readonly updateRouting: (
    input: WorkjetGatewayUpdateRoutingInput,
  ) => Effect.Effect<WorkjetGatewayUpdateRoutingResult, WorkjetGatewayOperationError>;
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
    const hostPidPath = platform.joinPath(serverConfig.stateDir, "provider-gateway-host.pid.json");
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
      routingStrategy: WORKJET_GATEWAY_DEFAULT_ROUTING_STRATEGY,
      providerPools: [],
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

    // A missing configuration file is the bootstrap state: the host starts
    // with only its management/OAuth surface so the first login can happen.
    const bootstrapConfiguration: ProviderGatewayConfiguration = {
      schemaVersion: 1,
      defaultProvider: "claude",
      accounts: [],
      pools: [],
      routes: [],
      routingStrategy: WORKJET_GATEWAY_DEFAULT_ROUTING_STRATEGY,
    };

    const loadConfiguration = async (): Promise<ProviderGatewayConfiguration> => {
      let raw: string;
      try {
        raw = await platform.readText(configurationPath, CONFIG_MAX_BYTES);
      } catch (error) {
        if (isRecord(error) && (error as { readonly code?: unknown }).code === "ENOENT") {
          return bootstrapConfiguration;
        }
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

    /**
     * A gateway host that outlived its parent server keeps the stable
     * provider port bound, so the next spawn dies on bind and used to surface
     * as "invalid readiness" with no path forward short of a manual kill. The
     * pid file written on every spawn names that previous host; a live
     * process there is signalled and awaited before a new host starts. The
     * file is removed unconditionally — a stale entry for a dead pid is just
     * noise, and the reap must never loop on it.
     */
    const reapStaleHost = async (): Promise<void> => {
      let raw: string;
      try {
        raw = await platform.readText(hostPidPath, 4096);
      } catch {
        return;
      }
      await platform.remove(hostPidPath).catch(() => undefined);
      let pid: number | undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          isRecord(parsed) &&
          typeof parsed.pid === "number" &&
          Number.isInteger(parsed.pid) &&
          parsed.pid > 1
        ) {
          pid = parsed.pid;
        }
      } catch {
        return;
      }
      if (pid === undefined || pid === hostProcess?.pid) return;
      if (!platform.signalProcess(pid, "SIGTERM")) return;
      const polls = 20;
      const pollMs = Math.max(50, Math.floor(shutdownTimeoutMs / polls));
      for (let attempt = 0; attempt < polls; attempt += 1) {
        if (!platform.signalProcess(pid, "probe")) return;
        await platform.sleep(pollMs);
      }
      platform.signalProcess(pid, "SIGKILL");
      await platform.sleep(pollMs);
    };

    const runStart = async (): Promise<WorkjetGatewayStatus> => {
      if (currentStatus.phase === "ready") return currentStatus;
      if (stopFlight !== undefined) await stopFlight;
      let configuration = await loadConfiguration();
      if (configuration.providerPort === undefined) {
        // Reserve a stable provider port once so harness sessions routed
        // through the gateway survive gateway restarts.
        const providerPort = await platform.allocateLoopbackPort().catch(() => undefined);
        if (providerPort !== undefined) {
          configuration = { ...configuration, providerPort };
          await platform
            .writePrivateText(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`)
            .catch(() => undefined);
        }
      }
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
      await reapStaleHost();
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
      // Written before readiness on purpose: a host that crashes mid-startup
      // (or a server that dies here) still gets reaped on the next start.
      await platform
        .writePrivateText(hostPidPath, `${JSON.stringify({ schemaVersion: 1, pid: child.pid })}\n`)
        .catch(() => undefined);
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
      await platform.remove(hostPidPath).catch(() => undefined);
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

    // OAuth-only: an API-key provider has no browser login route at all.
    const OAUTH_BEGIN_ROUTES: Record<WorkjetGatewayOauthProvider, string> = {
      claude: "/v0/management/anthropic-auth-url",
      codex: "/v0/management/codex-auth-url",
      antigravity: "/v0/management/antigravity-auth-url",
      // Device flow: the returned authorization_url is xAI's verification
      // page for the device code; polling works exactly like the others.
      xai: "/v0/management/xai-auth-url",
    };
    const HOST_PROVIDERS: Record<string, WorkjetGatewayOauthProvider> = {
      anthropic: "claude",
      codex: "codex",
      antigravity: "antigravity",
      xai: "xai",
    };
    const MAX_TOKEN_BYTES = 32 * 1024;
    const textEncoder = new TextEncoder();

    const requireManagement = (): { readonly endpoint: string; readonly key: string } => {
      if (
        currentStatus.phase !== "ready" ||
        currentStatus.managementEndpoint === null ||
        managementCredential === undefined
      ) {
        throw safeError("gateway-not-ready");
      }
      return { endpoint: currentStatus.managementEndpoint, key: managementCredential };
    };

    const boundedText = (value: unknown, maximumLength: number): string | undefined =>
      typeof value === "string" && value.trim() !== "" && value.length <= maximumLength
        ? value
        : undefined;

    const runOauthStart = async (
      input: WorkjetGatewayOauthStartInput,
    ): Promise<WorkjetGatewayOauthSession> => {
      // Adding the first account must not require a manual "start gateway"
      // step: an OAuth begin on a stopped/faulted gateway starts it.
      if (currentStatus.phase !== "ready") {
        await startSingleFlight();
      }
      const { endpoint, key } = requireManagement();
      let response: unknown;
      try {
        response = await platform.managementGet(
          endpoint,
          OAUTH_BEGIN_ROUTES[input.provider],
          key,
          MANAGEMENT_MAX_BYTES,
        );
      } catch {
        throw safeError("oauth-unavailable");
      }
      if (!isRecord(response)) throw safeError("oauth-unavailable");
      const state = boundedText(response.state, 128);
      const authorizationUrl = boundedText(response.authorization_url, 2048);
      if (
        state === undefined ||
        authorizationUrl === undefined ||
        !(authorizationUrl.startsWith("https://") || authorizationUrl.startsWith("http://"))
      ) {
        throw safeError("oauth-unavailable");
      }
      return { schemaVersion: 1, provider: input.provider, state, authorizationUrl };
    };

    const secretSlug = (value: string): string => {
      const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "")
        .slice(0, 48);
      return slug === "" ? "account" : slug;
    };

    interface ClaimedCredential {
      readonly provider: WorkjetGatewayOauthProvider;
      readonly label: string;
      readonly models: ReadonlyArray<string>;
      readonly secrets: Readonly<Record<string, string>>;
    }

    const REQUIRED_SECRET_KEYS: Record<WorkjetGatewayOauthProvider, ReadonlyArray<string>> = {
      claude: ["access_token_secret", "refresh_token_secret"],
      codex: ["id_token_secret", "access_token_secret", "refresh_token_secret"],
      antigravity: ["access_token_secret", "refresh_token_secret", "state_secret"],
      xai: ["access_token_secret", "refresh_token_secret"],
    };

    const decodeClaim = (value: unknown): ReadonlyArray<ClaimedCredential> => {
      if (!isRecord(value) || !Array.isArray(value.credentials) || value.credentials.length === 0) {
        throw safeError("oauth-session-invalid");
      }
      return value.credentials.map((entry): ClaimedCredential => {
        if (!isRecord(entry) || !isRecord(entry.account) || !isRecord(entry.secrets)) {
          throw safeError("oauth-session-invalid");
        }
        const hostProvider =
          typeof entry.account.provider === "string" ? entry.account.provider : "";
        const provider = HOST_PROVIDERS[hostProvider];
        if (provider === undefined) throw safeError("oauth-session-invalid");
        const secrets: Record<string, string> = {};
        for (const secretKey of REQUIRED_SECRET_KEYS[provider]) {
          const secretValue = entry.secrets[secretKey];
          if (
            typeof secretValue !== "string" ||
            secretValue === "" ||
            platform.byteLength(secretValue) > MAX_TOKEN_BYTES
          ) {
            throw safeError("oauth-session-invalid");
          }
          secrets[secretKey] = secretValue;
        }
        const label =
          boundedText(entry.account.label, 160) ??
          boundedText(entry.account.auth_index, 160) ??
          "account";
        const models = Array.isArray(entry.account.models)
          ? entry.account.models.flatMap((model) => {
              const bounded = boundedText(model, 160);
              return bounded === undefined ? [] : [bounded.trim()];
            })
          : [];
        return { provider, label, models: [...new Set(models)].slice(0, 256), secrets };
      });
    };

    const persistClaimedAccounts = async (
      claimed: ReadonlyArray<ClaimedCredential>,
    ): Promise<ReadonlyArray<string>> => {
      const existing = await loadConfiguration().catch(() => undefined);
      const accounts: Array<GatewayAccount> = [...(existing?.accounts ?? [])];
      const usedIds = new Set(accounts.map((account) => account.id));
      const createdIds: Array<string> = [];
      for (const credential of claimed) {
        if (credential.provider === "antigravity" && existing?.antigravityOauth === undefined) {
          // Without the OAuth client secrets the resulting configuration could
          // never decode or start; refuse instead of writing a broken config.
          throw safeError("invalid-configuration");
        }
        const base = `${credential.provider}-${secretSlug(credential.label)}`;
        let id = base;
        for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${base}-${suffix}`;
        usedIds.add(id);
        const reference = (kind: string): GatewaySecretReference => ({
          scope: GATEWAY_SECRET_SCOPE,
          name: `account-${id}-${kind}`,
        });
        const writeSecret = async (ref: GatewaySecretReference, value: string): Promise<void> => {
          await runPromise(secrets.set(secretStoreName(ref), textEncoder.encode(value))).catch(
            () => {
              throw safeError("secret-unavailable");
            },
          );
        };
        const common = {
          id,
          label: credential.label,
          enabled: true,
          priority: 0,
          weight: 1,
          models: credential.models,
        };
        if (credential.provider === "claude") {
          const accessTokenSecret = reference("access-token");
          const refreshTokenSecret = reference("refresh-token");
          await writeSecret(accessTokenSecret, credential.secrets["access_token_secret"] ?? "");
          await writeSecret(refreshTokenSecret, credential.secrets["refresh_token_secret"] ?? "");
          accounts.push({ ...common, provider: "claude", accessTokenSecret, refreshTokenSecret });
        } else if (credential.provider === "xai") {
          const accessTokenSecret = reference("access-token");
          const refreshTokenSecret = reference("refresh-token");
          await writeSecret(accessTokenSecret, credential.secrets["access_token_secret"] ?? "");
          await writeSecret(refreshTokenSecret, credential.secrets["refresh_token_secret"] ?? "");
          accounts.push({ ...common, provider: "xai", accessTokenSecret, refreshTokenSecret });
        } else if (credential.provider === "codex") {
          const idTokenSecret = reference("id-token");
          const accessTokenSecret = reference("access-token");
          const refreshTokenSecret = reference("refresh-token");
          await writeSecret(idTokenSecret, credential.secrets["id_token_secret"] ?? "");
          await writeSecret(accessTokenSecret, credential.secrets["access_token_secret"] ?? "");
          await writeSecret(refreshTokenSecret, credential.secrets["refresh_token_secret"] ?? "");
          accounts.push({
            ...common,
            provider: "codex",
            idTokenSecret,
            accessTokenSecret,
            refreshTokenSecret,
          });
        } else {
          const accessTokenSecret = reference("access-token");
          const refreshTokenSecret = reference("refresh-token");
          const stateSecret = reference("state");
          await writeSecret(accessTokenSecret, credential.secrets["access_token_secret"] ?? "");
          await writeSecret(refreshTokenSecret, credential.secrets["refresh_token_secret"] ?? "");
          await writeSecret(stateSecret, credential.secrets["state_secret"] ?? "");
          accounts.push({
            ...common,
            provider: "antigravity",
            accessTokenSecret,
            refreshTokenSecret,
            stateSecret,
          });
        }
        createdIds.push(id);
      }
      const candidate = {
        schemaVersion: 1,
        defaultProvider: existing?.defaultProvider ?? claimed[0]?.provider ?? "claude",
        accounts,
        pools: existing?.pools ?? [],
        routes: existing?.routes ?? [],
        routingStrategy: existing?.routingStrategy ?? WORKJET_GATEWAY_DEFAULT_ROUTING_STRATEGY,
        ...(existing?.providerPort !== undefined ? { providerPort: existing.providerPort } : {}),
        ...(existing?.antigravityOauth ? { antigravityOauth: existing.antigravityOauth } : {}),
      };
      const decoded = decodeProviderGatewayConfiguration(JSON.parse(JSON.stringify(candidate)));
      if (decoded === undefined) throw safeError("invalid-configuration");
      await platform
        .writePrivateText(configurationPath, `${JSON.stringify(candidate, null, 2)}\n`)
        .catch(() => {
          throw safeError("invalid-configuration");
        });
      return createdIds;
    };

    const runOauthPoll = async (
      input: WorkjetGatewayOauthPollInput,
    ): Promise<WorkjetGatewayOauthPollResult> => {
      const { endpoint, key } = requireManagement();
      let response: unknown;
      try {
        response = await platform.managementGet(
          endpoint,
          `/v0/management/oauth/status?state=${encodeURIComponent(input.state)}`,
          key,
          MANAGEMENT_MAX_BYTES,
        );
      } catch {
        throw safeError("oauth-session-invalid");
      }
      if (!isRecord(response)) throw safeError("oauth-session-invalid");
      if (response.pending === true) {
        return { schemaVersion: 1, pending: true, failed: false, completedAccountIds: [] };
      }
      if (typeof response.error === "string" && response.error !== "") {
        return { schemaVersion: 1, pending: false, failed: true, completedAccountIds: [] };
      }
      if (!Array.isArray(response.credentials) || response.credentials.length === 0) {
        return { schemaVersion: 1, pending: false, failed: true, completedAccountIds: [] };
      }
      let claim: unknown;
      try {
        claim = await platform.managementRequest(
          endpoint,
          `/v0/management/oauth/session/${encodeURIComponent(input.state)}/claim`,
          key,
          "POST",
          MANAGEMENT_MAX_BYTES,
        );
      } catch {
        throw safeError("oauth-session-invalid");
      }
      const createdIds = await persistClaimedAccounts(decodeClaim(claim));
      // Reload the gateway so the new account is served; a failed restart is
      // visible through status() and must not undo the successful login.
      try {
        await stopSingleFlight();
        await startSingleFlight();
      } catch {
        // status() carries the failure reason.
      }
      return {
        schemaVersion: 1,
        pending: false,
        failed: false,
        completedAccountIds: createdIds.map((id) => WorkjetGatewayAccountId.make(id)),
      };
    };

    /**
     * Persists one API-key account. The credential path is deliberately the
     * same as the OAuth claim path: secret store first, then a configuration
     * that carries only the reference, then a gateway reload. The key is bound
     * again here rather than trusted from the decoded payload, so a caller
     * bypassing the schema still cannot push an oversized or control-character
     * credential into the Rust host's header construction.
     */
    const runAddApiKeyAccount = async (
      input: WorkjetGatewayAddApiKeyAccountInput,
    ): Promise<WorkjetGatewayAddApiKeyAccountResult> => {
      if (!isAcceptableApiKey(input.apiKey)) throw safeError("invalid-configuration");
      const apiKey = input.apiKey.trim();
      const existing = await loadConfiguration().catch(() => undefined);
      const accounts: Array<GatewayAccount> = [...(existing?.accounts ?? [])];
      const usedIds = new Set(accounts.map((account) => account.id));
      const base = `${input.provider}-${secretSlug(input.label)}`;
      let id = base;
      for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${base}-${suffix}`;
      const apiKeySecret: GatewaySecretReference = {
        scope: GATEWAY_SECRET_SCOPE,
        name: `account-${id}-api-key`,
      };
      await runPromise(
        secrets.set(secretStoreName(apiKeySecret), textEncoder.encode(apiKey)),
      ).catch(() => {
        throw safeError("secret-unavailable");
      });
      const suffix = credentialSuffix(apiKey);
      accounts.push({
        id,
        label: input.label,
        provider: input.provider,
        enabled: true,
        priority: 0,
        weight: 1,
        models: [],
        apiKeySecret,
        ...(suffix ? { credentialSuffix: suffix } : {}),
      });
      const candidate = {
        schemaVersion: 1,
        // The first account of any kind also becomes the default provider, so
        // a gateway whose only account is an API-key account still routes.
        defaultProvider: existing?.accounts.length ? existing.defaultProvider : input.provider,
        accounts,
        pools: existing?.pools ?? [],
        routes: existing?.routes ?? [],
        routingStrategy: existing?.routingStrategy ?? WORKJET_GATEWAY_DEFAULT_ROUTING_STRATEGY,
        ...(existing?.providerPort !== undefined ? { providerPort: existing.providerPort } : {}),
        ...(existing?.antigravityOauth ? { antigravityOauth: existing.antigravityOauth } : {}),
      };
      const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
      // Belt and braces: the configuration document must never contain the key.
      if (
        decodeProviderGatewayConfiguration(JSON.parse(serialized)) === undefined ||
        serialized.includes(apiKey)
      ) {
        throw safeError("invalid-configuration");
      }
      await platform.writePrivateText(configurationPath, serialized).catch(() => {
        throw safeError("invalid-configuration");
      });
      // Reload so the new account is served. A failed restart is visible
      // through status() and must not undo the successful key write.
      try {
        await stopSingleFlight();
        await startSingleFlight();
      } catch {
        // status() carries the failure reason.
      }
      return { schemaVersion: 1, accountId: WorkjetGatewayAccountId.make(id) };
    };

    const GATEWAY_PROVIDERS: ReadonlyArray<WorkjetGatewayProvider> = [
      "claude",
      "codex",
      "antigravity",
      "zai",
      "minimax",
      "xai",
      "kimi",
    ];
    const isGatewayProvider = (value: string): value is WorkjetGatewayProvider =>
      (GATEWAY_PROVIDERS as ReadonlyArray<string>).includes(value);

    /**
     * Reads the two management routes the host genuinely serves and reports
     * exactly what they say.
     *
     * What is deliberately NOT here: per-account cooldown, rate-limit class,
     * last failure and quota state. The host tracks all of that in a
     * `CooldownStateRecord` held by an in-process store, and its management
     * surface publishes no route for it — `/v0/management/api-key-usage` and
     * `/v0/management/usage-queue` answer 404 on this host because it attaches
     * no source for them, and there is no read route for cooldown state at all.
     * The host also exposes no concurrency or capacity figure anywhere. Both
     * are therefore reported as `not-reported-by-host` instead of being
     * reconstructed from configuration, which would look like health while
     * being nothing of the kind.
     */
    const runHealth = async (): Promise<WorkjetGatewayHealth> => {
      const { endpoint, key } = requireManagement();
      let status: unknown;
      let configuration: unknown;
      try {
        [status, configuration] = await Promise.all([
          platform.managementGet(
            endpoint,
            "/v0/management/runtime-status",
            key,
            MANAGEMENT_MAX_BYTES,
          ),
          platform.managementGet(
            endpoint,
            "/v0/management/runtime-config",
            key,
            MANAGEMENT_MAX_BYTES,
          ),
        ]);
      } catch {
        throw safeError("management-unavailable");
      }
      const decodedStatus = decodeRuntimeStatus(status);
      const decodedConfiguration = decodeRuntimeConfigSummary(configuration);
      if (decodedStatus === undefined || decodedConfiguration === undefined) {
        throw safeError("management-unavailable");
      }
      // The host reports one phase for the whole provider endpoint, not one per
      // provider, so every provider carries that same phase rather than an
      // invented per-provider state.
      const providers: ReadonlyArray<WorkjetGatewayProviderHealth> =
        decodedConfiguration.providers.flatMap((summary) =>
          isGatewayProvider(summary.provider)
            ? [
                {
                  provider: summary.provider,
                  accountCount: summary.accountCount,
                  enabledAccountCount: summary.enabledAccountCount,
                  modelIds: summary.modelIds,
                  phase: decodedStatus.providerPhase satisfies WorkjetGatewayProviderPhase,
                },
              ]
            : [],
        );
      const activeProvider = decodedStatus.activeProvider ?? decodedConfiguration.defaultProvider;
      return {
        schemaVersion: 1,
        observedAtMs: Math.max(0, Math.trunc(platform.now())),
        activeProvider:
          activeProvider !== undefined && isGatewayProvider(activeProvider) ? activeProvider : null,
        providers,
        accountHealth: "not-reported-by-host",
        capacity: "not-reported-by-host",
      };
    };

    /**
     * Asks the host which models it serves per provider.
     *
     * The host answers from `GET /v0/management/model-definitions/<channel>`,
     * which is its own pinned catalog compiled into the binary. It makes NO
     * upstream capability call for this — not at request time and not on the
     * management surface — so every model is labelled `gateway-catalog` and the
     * models recorded on the accounts are merged in as `account-configuration`.
     * Neither label may be presented as a live provider answer. A provider the
     * host has no channel for (zai, minimax) reports `catalogAvailable: false`
     * and lists only its configured models.
     */
    const runDiscoverModels = async (): Promise<WorkjetGatewayModelDiscovery> => {
      const { endpoint, key } = requireManagement();
      const configuration = await loadConfiguration();
      const observedAtMs = Math.max(0, Math.trunc(platform.now()));
      const providers: Array<WorkjetGatewayProviderModels> = [];
      for (const provider of GATEWAY_PROVIDERS) {
        const accounts = configuration.accounts.filter(
          (account) => account.provider === provider && account.enabled,
        );
        if (accounts.length === 0) continue;
        const channel = GATEWAY_MODEL_CHANNELS[provider];
        let catalog: ReadonlyArray<{ readonly id: string; readonly displayName: string }> = [];
        let catalogAvailable = false;
        if (channel !== null) {
          try {
            const response = await platform.managementGet(
              endpoint,
              `/v0/management/model-definitions/${encodeURIComponent(channel)}`,
              key,
              MANAGEMENT_MAX_BYTES,
            );
            const decoded = decodeModelDefinitions(response, channel);
            if (decoded !== undefined) {
              catalog = decoded;
              catalogAvailable = true;
            }
          } catch {
            // A channel the host refuses is reported as unavailable for this
            // provider; it must not fail the whole discovery.
            catalogAvailable = false;
          }
        }
        const models: Array<WorkjetGatewayDiscoveredModel> = catalog.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          source: "gateway-catalog" as const,
        }));
        const known = new Set(models.map((model) => model.id));
        for (const account of accounts) {
          for (const model of account.models) {
            if (known.has(model)) continue;
            known.add(model);
            models.push({ id: model, displayName: model, source: "account-configuration" });
          }
        }
        providers.push({
          provider,
          channel,
          catalogAvailable,
          models: models.slice(0, 256),
        });
      }
      return { schemaVersion: 1, observedAtMs, providers };
    };

    /**
     * Rewrites the pool configuration and reloads the host.
     *
     * The host's `PUT /v0/management/runtime-config` route exists but this
     * host's config source refuses every mutation (`replace` returns
     * `Invalid`), so the durable configuration file is the only way to change a
     * strategy or a membership. That is the same path the OAuth claim and the
     * API-key add already take: write the file, then stop and start the host.
     */
    const runUpdateRouting = async (
      input: WorkjetGatewayUpdateRoutingInput,
    ): Promise<WorkjetGatewayUpdateRoutingResult> => {
      const existing = await loadConfiguration();
      const updates = new Map(input.accounts.map((update) => [String(update.accountId), update]));
      // An edit naming an account that does not exist is a stale client, not a
      // no-op: refuse it instead of silently applying the rest.
      if (
        [...updates.keys()].some(
          (accountId) => !existing.accounts.some((account) => account.id === accountId),
        )
      ) {
        throw safeError("invalid-configuration");
      }
      const accounts = existing.accounts.map((account) => {
        const update = updates.get(account.id);
        return update === undefined
          ? account
          : {
              ...account,
              enabled: update.enabled,
              priority: update.priority,
              weight: update.weight,
              // Omitted means "not editing this list", which must stay
              // distinct from an empty array clearing it.
              ...(update.models === undefined ? {} : { models: [...update.models] }),
            };
      });
      const candidate = {
        schemaVersion: 1,
        defaultProvider: existing.defaultProvider,
        accounts,
        pools: existing.pools,
        routes: existing.routes,
        routingStrategy: input.strategy,
        ...(existing.providerPort !== undefined ? { providerPort: existing.providerPort } : {}),
        ...(existing.antigravityOauth ? { antigravityOauth: existing.antigravityOauth } : {}),
      };
      const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
      // Disabling the default provider's last enabled account would produce a
      // configuration the host refuses to start on; decoding catches that here
      // instead of after the gateway is already down.
      const decoded = decodeProviderGatewayConfiguration(JSON.parse(serialized));
      if (decoded === undefined) throw safeError("invalid-configuration");
      await platform.writePrivateText(configurationPath, serialized).catch(() => {
        throw safeError("invalid-configuration");
      });
      currentCatalog = gatewayCatalog(decoded);
      try {
        await stopSingleFlight();
        await startSingleFlight();
      } catch {
        // status() carries the failure reason; the edit itself is persisted.
      }
      return { schemaVersion: 1, catalog: currentCatalog };
    };

    const runOauthCancel = async (input: WorkjetGatewayOauthPollInput): Promise<void> => {
      const { endpoint, key } = requireManagement();
      try {
        await platform.managementRequest(
          endpoint,
          `/v0/management/oauth/session/${encodeURIComponent(input.state)}`,
          key,
          "DELETE",
          MANAGEMENT_MAX_BYTES,
        );
      } catch {
        throw safeError("oauth-session-invalid");
      }
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
      oauthStart: (input) =>
        Effect.tryPromise({
          try: () => runOauthStart(input),
          catch: (error) =>
            isGatewayOperationError(error) ? error : safeError("oauth-unavailable"),
        }),
      oauthPoll: (input) =>
        Effect.tryPromise({
          try: () => runOauthPoll(input),
          catch: (error) =>
            isGatewayOperationError(error) ? error : safeError("oauth-unavailable"),
        }),
      oauthCancel: (input) =>
        Effect.tryPromise({
          try: () => runOauthCancel(input),
          catch: (error) =>
            isGatewayOperationError(error) ? error : safeError("oauth-session-invalid"),
        }),
      addApiKeyAccount: (input) =>
        Effect.tryPromise({
          try: () => runAddApiKeyAccount(input),
          catch: (error) =>
            isGatewayOperationError(error) ? error : safeError("invalid-configuration"),
        }),
      health: () =>
        Effect.tryPromise({
          try: runHealth,
          catch: (error) =>
            isGatewayOperationError(error) ? error : safeError("management-unavailable"),
        }),
      discoverModels: () =>
        Effect.tryPromise({
          try: runDiscoverModels,
          catch: (error) =>
            isGatewayOperationError(error) ? error : safeError("management-unavailable"),
        }),
      updateRouting: (input) =>
        Effect.tryPromise({
          try: () => runUpdateRouting(input),
          catch: (error) =>
            isGatewayOperationError(error) ? error : safeError("invalid-configuration"),
        }),
    });
  });

export const layerWithOptions = (options?: ProviderGatewayServiceOptions) =>
  Layer.effect(ProviderGatewayService, make(options));

export const layer = layerWithOptions();
