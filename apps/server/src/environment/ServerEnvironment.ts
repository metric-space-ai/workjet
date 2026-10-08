import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@workjet/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@workjet/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readAgentActivityPublishingActive } from "../cloud/config.ts";
import { resolveServerSelfUpdateCapability } from "../cloud/selfUpdate.ts";
import { resolveServiceLauncherMode } from "../cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

export class ServerEnvironmentIdPersistenceError extends Schema.TaggedErrorClass<ServerEnvironmentIdPersistenceError>()(
  "ServerEnvironmentIdPersistenceError",
  {
    operation: Schema.Literals(["check", "read", "write"]),
    environmentIdPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server environment ID ${this.operation} failed at '${this.environmentIdPath}'.`;
  }
}

export class ServerEnvironment extends Context.Service<
  ServerEnvironment,
  {
    readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
    readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
  }
>()("workjet/environment/ServerEnvironment") {}

function platformOs(platform: NodeJS.Platform): ExecutionEnvironmentDescriptor["platform"]["os"] {
  switch (platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
}

function platformArch(
  architecture: NodeJS.Architecture,
): ExecutionEnvironmentDescriptor["platform"]["arch"] {
  switch (architecture) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x64";
    default:
      return "other";
  }
}

/** Optional host metadata must not delay or prevent server startup. */
export const readServerHostId = Effect.fn("ServerEnvironment.readServerHostId")(function* (
  platform: NodeJS.Platform,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const commandHostId = (command: string, args: readonly string[], pattern: RegExp) =>
    processRunner
      .run({
        command,
        args,
        timeout: "2 seconds",
        maxOutputBytes: 16 * 1024,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((result) =>
          result.code === 0 ? pattern.exec(result.stdout)?.[1]?.trim() : undefined,
        ),
        Effect.catch(() => Effect.succeed(undefined)),
      );
  const raw = yield* platform === "linux"
    ? fileSystem.readFileString("/etc/machine-id").pipe(
        Effect.map((value) => value.trim()),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    : platform === "darwin"
      ? commandHostId(
          "ioreg",
          ["-rd1", "-c", "IOPlatformExpertDevice"],
          /"IOPlatformUUID" = "([^"]+)"/,
        )
      : platform === "win32"
        ? commandHostId(
            "reg",
            ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
            /MachineGuid\s+REG_SZ\s+(\S+)/,
          )
        : Effect.succeed(undefined);
  const normalized = raw?.toLowerCase();
  if (
    !normalized ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(normalized) ||
    /^0[-0]*$/.test(normalized)
  )
    return undefined;
  const crypto = yield* Crypto.Crypto;
  // Keep the OS identity local; expose an app-scoped stable digest.
  return yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`workjet:computer:v1:${platform}:${normalized}`))
    .pipe(
      Effect.map(
        (digest) =>
          `workjet-host-v1:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      ),
      Effect.catch(() => Effect.succeed(undefined)),
    );
});

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;

  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;

  const readPersistedEnvironmentId = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(serverConfig.environmentIdPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentIdPersistenceError({
            operation: "check",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );
    if (!exists) {
      return null;
    }

    const raw = yield* fileSystem.readFileString(serverConfig.environmentIdPath).pipe(
      Effect.map((value) => value.trim()),
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentIdPersistenceError({
            operation: "read",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );

    return raw.length > 0 ? raw : null;
  });

  const persistEnvironmentId = (value: string) =>
    fileSystem.writeFileString(serverConfig.environmentIdPath, `${value}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentIdPersistenceError({
            operation: "write",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );

  const environmentIdRaw = yield* Effect.gen(function* () {
    const persisted = yield* readPersistedEnvironmentId;
    if (persisted) {
      return persisted;
    }

    const generated = yield* crypto.randomUUIDv4;
    yield* persistEnvironmentId(generated);
    return generated;
  });

  const environmentId = EnvironmentId.make(environmentIdRaw);
  // Keep this stable across descriptor reads, but never recover it from disk:
  // a replacement runtime must not inherit the previous process's identity.
  const runtimeInstanceId = yield* crypto.randomUUIDv4;
  const cwdBaseName = path.basename(serverConfig.cwd).trim();
  const label = yield* resolveServerEnvironmentLabel({ cwdBaseName });
  const launcher = yield* resolveServiceLauncherMode();
  const serverSelfUpdate = resolveServerSelfUpdateCapability({
    desktopManaged: serverConfig.mode === "desktop",
    launcherManaged: launcher.managed,
  });

  const hostId = yield* readServerHostId(hostPlatform);

  const descriptor: ExecutionEnvironmentDescriptor = {
    environmentId,
    runtimeInstanceId,
    ...(hostId === undefined ? {} : { hostId }),
    label,
    platform: {
      os: platformOs(hostPlatform),
      arch: platformArch(hostArchitecture),
    },
    serverVersion: packageJson.version,
    capabilities: {
      repositoryIdentity: true,
      remoteWorkerDispatch: true,
      connectionProbe: true,
      pullRequests: true,
      threadSettlement: true,
      threadSnooze: true,
      threadPinning: true,
      threadPinReorder: true,
      threadTitleRegeneration: true,
      ...(serverSelfUpdate === null ? {} : { serverSelfUpdate }),
      ...(serverSelfUpdate === "boot-service" ? { serverSelfUpdateProgress: true } : {}),
    },
  };

  return ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    // The publish opt-in and relay link change at runtime (`workjet connect
    // publish`, the client settings toggle), so the capability is read per
    // descriptor request rather than baked in at startup.
    getDescriptor: readAgentActivityPublishingActive(secrets).pipe(
      Effect.map((agentActivityPublishing) => ({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, agentActivityPublishing },
      })),
    ),
  });
});

/**
 * ServerEnvironment is acquired from persisted filesystem and host-process
 * state. It intentionally has no fallback Layer.succeed value: callers must
 * provide the external platform services, a ServerConfig, and the
 * ServerSecretStore backing the descriptor's publishing capability.
 */
export const layer = Layer.effect(ServerEnvironment, make).pipe(Layer.provide(ProcessRunner.layer));
