import { WorkjetGatewayOperationError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { nodeProviderGatewayPlatform } from "./ProviderGatewayNodeAdapter.ts";
import {
  make,
  type GatewayHostProcess,
  type GatewayProcessExit,
  type ProviderGatewayPlatform,
  type ProviderGatewayServiceShape,
} from "./ProviderGatewayService.ts";

const configuration = `{
  "schemaVersion": 1,
  "defaultProvider": "codex",
  "accounts": [{
    "id": "codex-primary",
    "label": "Primary Codex",
    "provider": "codex",
    "models": ["gpt-test"],
    "idTokenSecret": { "scope": "workjet-provider-gateway", "name": "codex.id" },
    "accessTokenSecret": { "scope": "workjet-provider-gateway", "name": "codex.access" },
    "refreshTokenSecret": { "scope": "workjet-provider-gateway", "name": "codex.refresh" }
  }],
  "pools": [],
  "routes": []
}`;

interface DeferredExit {
  readonly promise: Promise<GatewayProcessExit>;
  readonly resolve: (exit: GatewayProcessExit) => void;
}

const deferredExit = (): DeferredExit => {
  let resolve!: (exit: GatewayProcessExit) => void;
  const promise = new Promise<GatewayProcessExit>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const iterable = (chunks: ReadonlyArray<string>): AsyncIterable<string> => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) yield chunk;
  },
});

const testConfig = ServerConfig.make({
  stateDir: "/state",
  secretsDir: "/state/secrets",
} as ServerConfig.ServerConfig["Service"]);

const testSecrets = ServerSecretStore.ServerSecretStore.of({
  get: () => Effect.succeed(Option.some(new TextEncoder().encode("provider-secret"))),
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
  remove: () => Effect.void,
});

const runGateway = <A, E>(
  platform: ProviderGatewayPlatform,
  use: (gateway: ProviderGatewayServiceShape) => Effect.Effect<A, E>,
  options: { readonly startupTimeoutMs?: number; readonly shutdownTimeoutMs?: number } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* make({ platform, executable: "/gateway-host", ...options });
      return yield* use(gateway);
    }),
  ).pipe(
    Effect.provideService(ServerConfig.ServerConfig, testConfig),
    Effect.provideService(ServerSecretStore.ServerSecretStore, testSecrets),
    Effect.runPromise,
  );

const readyHarness = () => {
  const exit = deferredExit();
  const kills: Array<NodeJS.Signals> = [];
  const writes: Array<string> = [];
  const removals: Array<string> = [];
  let spawnCount = 0;
  let stopped = false;
  const process: GatewayHostProcess = {
    pid: 321,
    stdout: iterable([
      '{"schema":"workjet.provider-gateway-host.readiness.v1","pid":321,"providerEndpoint":"http://127.0.0.1:41000/","managementEndpoint":"http://127.0.0.1:41001/","phase":"ready"}\n',
    ]),
    stderr: iterable([]),
    exit: exit.promise,
    kill: (signal) => {
      kills.push(signal);
      if (!stopped) {
        stopped = true;
        exit.resolve({ code: null, signal });
      }
      return true;
    },
  };
  const platform: ProviderGatewayPlatform = {
    ...nodeProviderGatewayPlatform,
    readText: async () => configuration,
    writePrivateText: async (_path, content) => {
      writes.push(content);
    },
    remove: async (path) => {
      removals.push(path);
    },
    spawn: (_executable, args) => {
      spawnCount += 1;
      expect(args).toEqual(["--config", "/state/provider-gateway-runtime.json"]);
      return process;
    },
    managementGet: async (_endpoint, route, key) => {
      expect(key).toBe("07".repeat(32));
      return route.endsWith("runtime-status")
        ? { schema: "workjet.provider-gateway.runtime-status.v1" }
        : { schema: "workjet.provider-gateway.runtime-summary.v1" };
    },
  };
  return {
    platform,
    exit,
    kills,
    writes,
    removals,
    spawnCount: () => spawnCount,
  };
};

describe("ProviderGatewayService", () => {
  it("single-flights start, publishes redacted state, and stops idempotently", async () => {
    const harness = readyHarness();
    await runGateway(harness.platform, (gateway) =>
      Effect.gen(function* () {
        const [left, right] = yield* Effect.all([gateway.start(), gateway.start()], {
          concurrency: "unbounded",
        });
        expect(left.phase).toBe("ready");
        expect(right).toEqual(left);
        expect(harness.spawnCount()).toBe(1);
        expect(Object.values(left)).not.toContain("provider-secret");
        expect(harness.writes.join("\n")).not.toContain("provider-secret");
        expect(harness.removals).toContain("/state/provider-gateway-runtime.json");

        const [firstStop, secondStop] = yield* Effect.all([gateway.stop(), gateway.stop()], {
          concurrency: "unbounded",
        });
        expect(firstStop.phase).toBe("stopped");
        expect(secondStop.phase).toBe("stopped");
        expect(harness.kills).toEqual(["SIGTERM"]);
      }),
    );
  });

  it("observes a crash after readiness without exposing process output", async () => {
    const harness = readyHarness();
    await runGateway(harness.platform, (gateway) =>
      Effect.gen(function* () {
        yield* gateway.start();
        harness.exit.resolve({ code: 17, signal: null });
        yield* Effect.sleep(0);
        const status = yield* gateway.status();
        expect(status.phase).toBe("faulted");
        expect(status.failureReason).toBe("process-exit");
        expect(Object.values(status)).not.toContain(17);
        expect(Object.values(status)).not.toContain("17");
      }),
    );
  });

  it("bounds startup, tears down the child, and reports only a typed timeout", async () => {
    const exit = deferredExit();
    const kills: Array<NodeJS.Signals> = [];
    const process: GatewayHostProcess = {
      pid: 654,
      stdout: {
        async *[Symbol.asyncIterator]() {
          await exit.promise;
        },
      },
      stderr: iterable(["Authorization: Bearer provider-secret"]),
      exit: exit.promise,
      kill: (signal) => {
        kills.push(signal);
        exit.resolve({ code: null, signal });
        return true;
      },
    };
    const platform: ProviderGatewayPlatform = {
      ...nodeProviderGatewayPlatform,
      readText: async () => configuration,
      writePrivateText: async () => undefined,
      remove: async () => undefined,
      spawn: () => process,
      managementGet: async () => {
        throw new Error("not reached");
      },
    };

    await expect(
      runGateway(platform, (gateway) => gateway.start(), {
        startupTimeoutMs: 5,
        shutdownTimeoutMs: 5,
      }),
    ).rejects.toMatchObject({
      _tag: "WorkjetGatewayOperationError",
      reason: "startup-timeout",
    } satisfies Partial<WorkjetGatewayOperationError>);
    expect(kills).toContain("SIGTERM");
  });

  it("boots the bootstrap host when no configuration file exists yet", async () => {
    const harness = readyHarness();
    const platform: ProviderGatewayPlatform = {
      ...harness.platform,
      readText: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    };
    await runGateway(platform, (gateway) =>
      Effect.gen(function* () {
        const status = yield* gateway.start();
        expect(status.phase).toBe("ready");
        expect(status.configuredAccountCount).toBe(0);
      }),
    );
    const runtimeWrite = harness.writes.find((content) =>
      content.includes("workjet.provider-gateway-host.v1"),
    );
    expect(runtimeWrite).toBeDefined();
    // A bootstrap host must not name a default provider.
    expect(runtimeWrite).not.toContain("defaultProvider");
    // The start reserves and persists a stable provider port, and the host
    // config binds it instead of an ephemeral port.
    const configurationWrite = harness.writes.find((content) => content.includes('"providerPort"'));
    expect(configurationWrite).toBeDefined();
    expect(runtimeWrite).not.toContain('"providerAddress": "127.0.0.1:0"');
  });

  it("refuses OAuth operations while the gateway is not running", async () => {
    const harness = readyHarness();
    await expect(
      runGateway(harness.platform, (gateway) => gateway.oauthStart({ provider: "codex" })),
    ).rejects.toMatchObject({
      _tag: "WorkjetGatewayOperationError",
      reason: "gateway-not-ready",
    });
  });

  it("runs begin, poll, claim, persist, and reload for a provider login", async () => {
    const storedSecrets = new Map<string, string>();
    const secretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeed(Option.some(new TextEncoder().encode("provider-secret"))),
      set: (name, value) =>
        Effect.sync(() => {
          storedSecrets.set(name, new TextDecoder().decode(value));
        }),
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
      remove: () => Effect.void,
    });
    const writes: Array<{ readonly path: string; readonly content: string }> = [];
    const claims: Array<string> = [];
    let spawnCount = 0;
    let polls = 0;
    const spawnProcess = (): GatewayHostProcess => {
      const exit = deferredExit();
      return {
        pid: 321,
        stdout: iterable([
          '{"schema":"workjet.provider-gateway-host.readiness.v1","pid":321,"providerEndpoint":"http://127.0.0.1:41000/","managementEndpoint":"http://127.0.0.1:41001/","phase":"ready"}\n',
        ]),
        stderr: iterable([]),
        exit: exit.promise,
        kill: (signal) => {
          exit.resolve({ code: null, signal });
          return true;
        },
      };
    };
    const platform: ProviderGatewayPlatform = {
      ...nodeProviderGatewayPlatform,
      readText: async (path) => {
        if (path.endsWith("provider-gateway.json")) {
          const written = writes.findLast((entry) => entry.path.endsWith("provider-gateway.json"));
          return written?.content ?? configuration;
        }
        return configuration;
      },
      writePrivateText: async (path, content) => {
        writes.push({ path, content });
      },
      remove: async () => undefined,
      spawn: () => {
        spawnCount += 1;
        return spawnProcess();
      },
      managementGet: async (_endpoint, route) => {
        if (route.endsWith("codex-auth-url")) {
          return {
            provider: "codex",
            state: "state-1",
            authorization_url: "https://auth.example.test/authorize?state=state-1",
          };
        }
        if (route.startsWith("/v0/management/oauth/status")) {
          polls += 1;
          return polls === 1
            ? { pending: true, error: null, credentials: [] }
            : {
                pending: false,
                error: null,
                credentials: [{ id: "codex:acct", provider: "codex", label: "user@example.test" }],
              };
        }
        return route.endsWith("runtime-status")
          ? { schema: "workjet.provider-gateway.runtime-status.v1" }
          : { schema: "workjet.provider-gateway.runtime-summary.v1" };
      },
      managementRequest: async (_endpoint, route, _key, method) => {
        claims.push(`${method} ${route}`);
        return {
          credentials: [
            {
              account: {
                id: "codex:acct",
                auth_index: "acct",
                label: "user@example.test",
                provider: "codex",
                disabled: false,
                models: [],
              },
              secrets: {
                id_token_secret: "id-token-material",
                access_token_secret: "access-token-material",
                refresh_token_secret: "refresh-token-material",
              },
            },
          ],
        };
      },
    };

    await Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* make({ platform, executable: "/gateway-host" });
        yield* gateway.start();
        const session = yield* gateway.oauthStart({ provider: "codex" });
        expect(session.state).toBe("state-1");
        expect(session.authorizationUrl.startsWith("https://")).toBe(true);
        const first = yield* gateway.oauthPoll({ state: session.state });
        expect(first.pending).toBe(true);
        const second = yield* gateway.oauthPoll({ state: session.state });
        expect(second.pending).toBe(false);
        expect(second.failed).toBe(false);
        expect(second.completedAccountIds).toEqual(["codex-user-example.test"]);
      }),
    ).pipe(
      Effect.provideService(ServerConfig.ServerConfig, testConfig),
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      Effect.runPromise,
    );

    expect(claims).toEqual(["POST /v0/management/oauth/session/state-1/claim"]);
    expect(
      storedSecrets.get("workjet-provider-gateway.account-codex-user-example.test-access-token"),
    ).toBe("access-token-material");
    expect(
      storedSecrets.get("workjet-provider-gateway.account-codex-user-example.test-id-token"),
    ).toBe("id-token-material");
    expect(
      storedSecrets.get("workjet-provider-gateway.account-codex-user-example.test-refresh-token"),
    ).toBe("refresh-token-material");
    const configWrite = writes.findLast((entry) => entry.path.endsWith("provider-gateway.json"));
    expect(configWrite).toBeDefined();
    expect(configWrite?.content).toContain('"codex-user-example.test"');
    expect(configWrite?.content).not.toContain("access-token-material");
    expect(configWrite?.content).not.toContain("refresh-token-material");
    // The login reloads the gateway so the new account is served.
    expect(spawnCount).toBe(2);
  });

  it("reports a failed login without claiming credentials", async () => {
    const harness = readyHarness();
    const platform: ProviderGatewayPlatform = {
      ...harness.platform,
      managementGet: async (endpoint, route, key, maximumBytes) => {
        if (route.startsWith("/v0/management/oauth/status")) {
          return { pending: false, error: "denied", credentials: [] };
        }
        return harness.platform.managementGet(endpoint, route, key, maximumBytes);
      },
      managementRequest: async () => {
        throw new Error("claim must not run");
      },
    };
    await runGateway(platform, (gateway) =>
      Effect.gen(function* () {
        yield* gateway.start();
        const result = yield* gateway.oauthPoll({ state: "state-x" });
        expect(result.failed).toBe(true);
        expect(result.completedAccountIds).toEqual([]);
      }),
    );
  });

  it("rejects malformed readiness as a redacted protocol failure", async () => {
    const exit = deferredExit();
    const process: GatewayHostProcess = {
      pid: 777,
      stdout: iterable(["plaintext-provider-secret\n"]),
      stderr: iterable([]),
      exit: exit.promise,
      kill: (signal) => {
        exit.resolve({ code: null, signal });
        return true;
      },
    };
    const platform: ProviderGatewayPlatform = {
      ...nodeProviderGatewayPlatform,
      readText: async () => configuration,
      writePrivateText: async () => undefined,
      remove: async () => undefined,
      spawn: () => process,
      managementGet: async () => ({}),
    };

    await expect(runGateway(platform, (gateway) => gateway.start())).rejects.toMatchObject({
      _tag: "WorkjetGatewayOperationError",
      reason: "invalid-readiness",
    });
  });
});
