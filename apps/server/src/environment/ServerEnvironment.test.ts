import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerEnvironment from "./ServerEnvironment.ts";

it.layer(NodeServices.layer)("server host identity", (it) => {
  const guid = "AABBCCDD-1234-5678-ABCD-0123456789AB";
  const read = (platform: NodeJS.Platform, text: string, code = 0) =>
    ServerEnvironment.readServerHostId(platform).pipe(
      Effect.provide(
        FileSystem.layerNoop({
          readFileString: () => Effect.succeed(text),
        }),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () =>
          Effect.succeed({
            stdout: text,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(code),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    );

  it.effect("reads platform IDs independently of the Workjet state root", () =>
    Effect.gen(function* () {
      const raw = "aabbccdd12345678abcd0123456789ab";
      const linux = yield* read("linux", `${raw}\n`);
      expect(linux).toMatch(/^workjet-host-v1:[a-f0-9]{64}$/);
      expect(linux).not.toContain(raw);
      expect(yield* read("linux", raw.toUpperCase())).toBe(linux);
      const changed = yield* read("linux", "00112233445566778899aabbccddeeff");
      expect(changed).toMatch(/^workjet-host-v1:[a-f0-9]{64}$/);
      expect(changed).not.toBe(linux);
      const mac = yield* read("darwin", `"IOPlatformUUID" = "${guid}"`);
      expect(mac).toMatch(/^workjet-host-v1:[a-f0-9]{64}$/);
      expect(yield* read("darwin", `"IOPlatformUUID" = "${guid.toLowerCase()}"`)).toBe(mac);
      const windows = yield* read("win32", `MachineGuid    REG_SZ    ${guid}\n`);
      expect(windows).toMatch(/^workjet-host-v1:[a-f0-9]{64}$/);
      expect(windows).not.toBe(mac);
    }),
  );

  it.effect("bounds commands and ignores optional filesystem and command failures", () =>
    Effect.gen(function* () {
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const failing = {
        run: (input: ProcessRunner.ProcessRunInput) => {
          calls.push(input);
          return Effect.fail(
            new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: 2_000,
            }),
          );
        },
      };
      const readFailure = (platform: NodeJS.Platform) =>
        ServerEnvironment.readServerHostId(platform).pipe(
          Effect.provide(FileSystem.layerNoop({})),
          Effect.provideService(ProcessRunner.ProcessRunner, failing),
        );
      expect(yield* readFailure("linux")).toBeUndefined();
      expect(yield* readFailure("darwin")).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.timeout).toBe("2 seconds");
      expect(calls[0]?.maxOutputBytes).toBe(16 * 1024);
      expect(calls[0]?.timeoutBehavior).toBe("timedOutResult");
    }),
  );

  it.effect("omits unavailable, uninitialized and malformed host identities", () =>
    Effect.gen(function* () {
      for (const text of [
        "",
        "uninitialized",
        "not a machine ID",
        "0".repeat(32),
        "1".repeat(34),
      ]) {
        expect(yield* read("linux", text)).toBeUndefined();
      }
      expect(yield* read("darwin", "other output")).toBeUndefined();
      expect(yield* read("win32", `MachineGuid REG_SZ ${guid}`, 1)).toBeUndefined();
      expect(yield* read("freebsd", guid)).toBeUndefined();
    }),
  );
});

const isServerEnvironmentIdPersistenceError = Schema.is(
  ServerEnvironment.ServerEnvironmentIdPersistenceError,
);

const makeServerEnvironmentLayer = (baseDir: string) =>
  ServerEnvironment.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

const emptySecretStoreLayer = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
    remove: () => Effect.void,
  }),
);

const makeServerConfig = Effect.fn(function* (baseDir: string) {
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

  return {
    ...derivedPaths,
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "workjet-server",
    cwd: process.cwd(),
    baseDir,
    mode: "web",
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    port: 0,
    host: undefined,
    desktopBootstrapToken: undefined,
    staticDir: undefined,
    devUrl: undefined,
    devAllowedOrigins: [],
    noBrowser: false,
    startupPresentation: "browser",
  } satisfies ServerConfig.ServerConfig["Service"];
});

it.layer(NodeServices.layer)("ServerEnvironmentLive", (it) => {
  it.effect("persists the environment id across service restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "workjet-server-environment-test-",
      });

      const first = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));
      const second = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));

      expect(first.environmentId).toBe(second.environmentId);
      expect(first.runtimeInstanceId).toEqual(expect.any(String));
      expect(second.runtimeInstanceId).toEqual(expect.any(String));
      expect(first.runtimeInstanceId).not.toBe(second.runtimeInstanceId);
      expect(second.capabilities.repositoryIdentity).toBe(true);
      expect(second.capabilities.connectionProbe).toBe(true);
      expect(second.capabilities.pullRequests).toBe(true);
      expect(second.capabilities.threadTitleRegeneration).toBe(true);
      expect(second.capabilities.agentActivityPublishing).toBe(false);
    }),
  );

  it.effect("reports agent activity publishing from the current secret state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "workjet-server-environment-publish-test-",
      });
      const testLayer = Layer.mergeAll(
        ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer)),
        ServerSecretStore.layer,
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        const encode = (value: string) => new TextEncoder().encode(value);

        const unlinked = yield* serverEnvironment.getDescriptor;
        expect(unlinked.capabilities.agentActivityPublishing).toBe(false);

        // The opt-in alone is not enough: without relay link credentials no
        // publish would leave this environment.
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, encode("true"));
        const withoutLink = yield* serverEnvironment.getDescriptor;
        expect(withoutLink.capabilities.agentActivityPublishing).toBe(false);

        // Empty credentials are as unconfigured as missing ones: the
        // publisher's truthiness gate skips them, so the capability must not
        // advertise publishing.
        yield* secrets.set(RELAY_URL_SECRET, encode(""));
        yield* secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("credential"));
        const emptyUrl = yield* serverEnvironment.getDescriptor;
        expect(emptyUrl.capabilities.agentActivityPublishing).toBe(false);

        yield* secrets.set(RELAY_URL_SECRET, encode("https://relay.example"));
        const linked = yield* serverEnvironment.getDescriptor;
        expect(linked.capabilities.agentActivityPublishing).toBe(true);

        // The toggle changes at runtime, so the same service instance must
        // reflect a flip without a restart.
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, encode("false"));
        const disabled = yield* serverEnvironment.getDescriptor;
        expect(disabled.capabilities.agentActivityPublishing).toBe(false);
        expect(disabled.runtimeInstanceId).toBe(unlinked.runtimeInstanceId);
      }).pipe(Effect.provide(testLayer));
    }),
  );

  it.effect("structures persisted environment id filesystem failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "workjet-server-environment-error-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      const environmentIdPath = serverConfig.environmentIdPath;
      const methodByOperation = {
        check: "exists",
        read: "readFileString",
        write: "writeFileString",
      } as const;

      for (const operation of ["check", "read", "write"] as const) {
        const writeAttempts: string[] = [];
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: methodByOperation[operation],
          description: "permission denied",
          pathOrDescriptor: environmentIdPath,
        });
        const failingFileSystemLayer = FileSystem.layerNoop({
          exists: () =>
            operation === "check" ? Effect.fail(cause) : Effect.succeed(operation === "read"),
          readFileString: () => Effect.fail(cause),
          writeFileString: (path) => {
            writeAttempts.push(path);
            return Effect.fail(cause);
          },
        });

        const error = yield* Effect.gen(function* () {
          const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
          return yield* serverEnvironment.getDescriptor;
        }).pipe(
          Effect.provide(
            ServerEnvironment.layer.pipe(
              Layer.provide(emptySecretStoreLayer),
              Layer.provide(Layer.merge(ServerConfig.layer(serverConfig), failingFileSystemLayer)),
            ),
          ),
          Effect.flip,
        );

        expect(isServerEnvironmentIdPersistenceError(error)).toBe(true);
        if (!isServerEnvironmentIdPersistenceError(error)) {
          throw error;
        }
        expect(error.operation).toBe(operation);
        expect(error.environmentIdPath).toBe(environmentIdPath);
        expect(error.cause).toBe(cause);
        expect(error.message).toBe(
          `Server environment ID ${operation} failed at '${environmentIdPath}'.`,
        );
        expect(writeAttempts).toEqual(operation === "write" ? [environmentIdPath] : []);
      }
    }),
  );
});
