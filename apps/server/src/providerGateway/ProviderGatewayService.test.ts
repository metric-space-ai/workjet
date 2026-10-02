import { WorkjetGatewayAccountId, WorkjetGatewayOperationError } from "@t3tools/contracts";
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
    process,
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

  it("starts the gateway implicitly when OAuth begins while it is not running", async () => {
    const harness = readyHarness();
    const platform: ProviderGatewayPlatform = {
      ...harness.platform,
      managementGet: async (_endpoint, route, key) => {
        expect(key).toBe("07".repeat(32));
        if (route.endsWith("-auth-url")) {
          return { state: "state-1", authorization_url: "https://auth.example/authorize" };
        }
        return route.endsWith("runtime-status")
          ? { schema: "workjet.provider-gateway.runtime-status.v1" }
          : { schema: "workjet.provider-gateway.runtime-summary.v1" };
      },
    };
    const session = await runGateway(platform, (gateway) =>
      gateway.oauthStart({ provider: "codex" }),
    );
    expect(session.provider).toBe("codex");
    expect(session.authorizationUrl).toBe("https://auth.example/authorize");
    expect(harness.spawnCount()).toBe(1);
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

describe("ProviderGatewayService · API-key accounts", () => {
  // Obviously fake, and deliberately distinctive so an assertion that it never
  // appears anywhere is meaningful.
  const API_KEY = "zk-test-not-a-real-key-abcd";

  /**
   * Records every secret write and every configuration write, so one test can
   * prove the whole flow: route -> secret store -> configuration reference.
   */
  const apiKeyHarness = () => {
    const base = readyHarness();
    const storedSecrets = new Map<string, string>();
    const secrets = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeed(Option.some(new TextEncoder().encode("provider-secret"))),
      set: (name: string, value: Uint8Array) =>
        Effect.sync(() => {
          storedSecrets.set(name, new TextDecoder().decode(value));
        }),
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
      remove: () => Effect.void,
    });
    return { ...base, storedSecrets, secrets };
  };

  const runWithSecrets = <A, E>(
    harness: ReturnType<typeof apiKeyHarness>,
    use: (gateway: ProviderGatewayServiceShape) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* make({ platform: harness.platform, executable: "/gateway-host" });
        return yield* use(gateway);
      }),
    ).pipe(
      Effect.provideService(ServerConfig.ServerConfig, testConfig),
      Effect.provideService(ServerSecretStore.ServerSecretStore, harness.secrets),
      Effect.runPromise,
    );

  it("stores the key as a secret and writes only a reference into the configuration", async () => {
    const harness = apiKeyHarness();
    const result = await runWithSecrets(harness, (gateway) =>
      gateway.addApiKeyAccount({ provider: "zai", label: "Z.ai key", apiKey: API_KEY }),
    );
    expect(result.accountId).toBe("zai-z.ai-key");

    // The key reached the secret store, under the account's own reference.
    const secretName = "workjet-provider-gateway.account-zai-z.ai-key-api-key";
    expect(harness.storedSecrets.get(secretName)).toBe(API_KEY);

    // ... and the configuration document carries the reference, never the key.
    const written = harness.writes.join("\n");
    expect(written).toContain("account-zai-z.ai-key-api-key");
    expect(written).not.toContain(API_KEY);
    // The gateway reloads after the write, so `writes` also holds the rendered
    // Rust host document; pick the gateway configuration itself.
    const configurationWrite = harness.writes.find((entry) => entry.includes("apiKeySecret"))!;
    const document = JSON.parse(configurationWrite) as {
      defaultProvider: string;
      accounts: ReadonlyArray<Record<string, unknown>>;
    };
    const account = document.accounts.find((entry) => entry.provider === "zai");
    expect(account?.apiKeySecret).toEqual({
      scope: "workjet-provider-gateway",
      name: "account-zai-z.ai-key-api-key",
    });
    expect(account).not.toHaveProperty("apiKey");
    // The existing codex account keeps the default provider.
    expect(document.defaultProvider).toBe("codex");
    // Only the masked suffix is retained for display.
    expect(account?.credentialSuffix).toBe("abcd");
  });

  it("adds an account for every supported API-key provider", async () => {
    for (const provider of ["zai", "minimax", "xai", "kimi"] as const) {
      const harness = apiKeyHarness();
      const result = await runWithSecrets(harness, (gateway) =>
        gateway.addApiKeyAccount({ provider, label: "key", apiKey: API_KEY }),
      );
      expect(result.accountId).toBe(`${provider}-key`);
      expect(harness.writes.join("\n")).not.toContain(API_KEY);
    }
  });

  it("refuses an out-of-bounds or control-character key without writing anything", async () => {
    for (const apiKey of ["x".repeat(513), `bad${String.fromCharCode(13)}injected`]) {
      const harness = apiKeyHarness();
      const failure = await runWithSecrets(harness, (gateway) =>
        gateway.addApiKeyAccount({ provider: "xai", label: "key", apiKey }).pipe(Effect.flip),
      );
      expect(failure).toBeInstanceOf(WorkjetGatewayOperationError);
      expect(failure.reason).toBe("invalid-configuration");
      expect(harness.storedSecrets.size).toBe(0);
      expect(harness.writes).toEqual([]);
    }
  });
});

/**
 * Pool editing, health, and model discovery. The management responder here
 * answers exactly what the Rust host answers — including the 404 it returns
 * for a channel it has no catalog for — so a test cannot pass against a
 * capability the host does not have.
 */
describe("ProviderGatewayService pools, health, and models", () => {
  const poolConfiguration = JSON.stringify({
    schemaVersion: 1,
    defaultProvider: "claude",
    routingStrategy: "round-robin",
    accounts: [
      {
        id: "claude-a",
        label: "Claude A",
        provider: "claude",
        enabled: true,
        priority: 0,
        weight: 1,
        models: ["claude-configured-only"],
        accessTokenSecret: { scope: "workjet-provider-gateway", name: "a.access" },
        refreshTokenSecret: { scope: "workjet-provider-gateway", name: "a.refresh" },
      },
      {
        id: "claude-b",
        label: "Claude B",
        provider: "claude",
        enabled: true,
        priority: 0,
        weight: 1,
        models: [],
        accessTokenSecret: { scope: "workjet-provider-gateway", name: "b.access" },
        refreshTokenSecret: { scope: "workjet-provider-gateway", name: "b.refresh" },
      },
      {
        id: "zai-a",
        label: "Z.ai A",
        provider: "zai",
        enabled: true,
        priority: 0,
        weight: 1,
        models: ["glm-5.3"],
        apiKeySecret: { scope: "workjet-provider-gateway", name: "zai.key" },
      },
    ],
    pools: [],
    routes: [],
  });

  const RUNTIME_STATUS = {
    schema: "workjet.provider-gateway.runtime-status.v1",
    main_responses_gateway: { phase: "ready", listen_addr: "127.0.0.1:41000" },
    codex_subscription_gateway: { phase: "ready", listen_addr: "127.0.0.1:41000" },
    management_gateway: { phase: "ready", listen_addr: "127.0.0.1:41001" },
    active_provider: "claude",
  };

  const RUNTIME_SUMMARY = {
    schema: "workjet.provider-gateway.runtime-summary.v1",
    revision: 1,
    default_provider: "claude",
    providers: [
      {
        provider: "claude",
        account_count: 2,
        enabled_account_count: 2,
        models: ["claude-configured-only"],
      },
      { provider: "zai", account_count: 1, enabled_account_count: 1, models: ["glm-5.3"] },
    ],
  };

  const poolHarness = (options: { readonly now?: number } = {}) => {
    const base = readyHarness();
    const writes: Array<string> = [];
    const routes: Array<string> = [];
    let stored = poolConfiguration;
    const platform: ProviderGatewayPlatform = {
      ...base.platform,
      now: () => options.now ?? 1_700_000_000_000,
      readText: async (path) => {
        if (path.endsWith("provider-gateway.json")) return stored;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      writePrivateText: async (path, content) => {
        writes.push(content);
        if (path.endsWith("provider-gateway.json")) stored = content;
      },
      managementGet: async (_endpoint, route) => {
        routes.push(route);
        if (route.endsWith("runtime-status")) return RUNTIME_STATUS;
        if (route.endsWith("runtime-config")) return RUNTIME_SUMMARY;
        if (route.endsWith("model-definitions/claude")) {
          return {
            channel: "claude",
            models: [
              { id: "claude-opus-4", display_name: "Claude Opus 4" },
              { id: "claude-haiku-4-5" },
            ],
          };
        }
        // The host has no zai channel: it answers 400/404, which the adapter
        // surfaces as a thrown request.
        throw new Error("unavailable");
      },
    };
    return { platform, writes, routes, configuration: () => stored };
  };

  const runPools = <A, E>(
    harness: ReturnType<typeof poolHarness>,
    use: (gateway: ProviderGatewayServiceShape) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* make({ platform: harness.platform, executable: "/gateway-host" });
        yield* gateway.start();
        return yield* use(gateway);
      }),
    ).pipe(
      Effect.provideService(ServerConfig.ServerConfig, testConfig),
      Effect.provideService(ServerSecretStore.ServerSecretStore, testSecrets),
      Effect.runPromise,
    );

  it("reports provider health from the host and refuses to invent per-account health", async () => {
    const harness = poolHarness({ now: 1_700_000_012_000 });
    const health = await runPools(harness, (gateway) => gateway.health());
    expect(health.observedAtMs).toBe(1_700_000_012_000);
    expect(health.activeProvider).toBe("claude");
    expect(health.providers).toEqual([
      {
        provider: "claude",
        accountCount: 2,
        enabledAccountCount: 2,
        modelIds: ["claude-configured-only"],
        phase: "ready",
      },
      {
        provider: "zai",
        accountCount: 1,
        enabledAccountCount: 1,
        modelIds: ["glm-5.3"],
        phase: "ready",
      },
    ]);
    // The host publishes no cooldown, rate-limit, or capacity figure at all.
    expect(health.accountHealth).toBe("not-reported-by-host");
    expect(health.capacity).toBe("not-reported-by-host");
  });

  it("fails health loudly when the host answers something that is not its own schema", async () => {
    const harness = poolHarness();
    const platform: ProviderGatewayPlatform = {
      ...harness.platform,
      managementGet: async (_endpoint, route) =>
        route.endsWith("runtime-status") ? RUNTIME_STATUS : { schema: "someone.else.v1" },
    };
    const failure = await Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* make({ platform, executable: "/gateway-host" });
        yield* gateway.start().pipe(Effect.orElseSucceed(() => undefined));
        return yield* gateway.health().pipe(Effect.flip);
      }),
    ).pipe(
      Effect.provideService(ServerConfig.ServerConfig, testConfig),
      Effect.provideService(ServerSecretStore.ServerSecretStore, testSecrets),
      Effect.runPromise,
    );
    expect(failure).toBeInstanceOf(WorkjetGatewayOperationError);
  });

  it("labels catalog models and configured models apart, and says when a provider has no catalog", async () => {
    const harness = poolHarness();
    const discovery = await runPools(harness, (gateway) => gateway.discoverModels());
    const claude = discovery.providers.find((entry) => entry.provider === "claude");
    expect(claude?.channel).toBe("claude");
    expect(claude?.catalogAvailable).toBe(true);
    expect(claude?.models).toEqual([
      { id: "claude-opus-4", displayName: "Claude Opus 4", source: "gateway-catalog" },
      { id: "claude-haiku-4-5", displayName: "claude-haiku-4-5", source: "gateway-catalog" },
      {
        id: "claude-configured-only",
        displayName: "claude-configured-only",
        source: "account-configuration",
      },
    ]);

    // The host has no zai channel, so the surface must say so rather than
    // present the configured list as a gateway answer.
    const zai = discovery.providers.find((entry) => entry.provider === "zai");
    expect(zai?.channel).toBeNull();
    expect(zai?.catalogAvailable).toBe(false);
    expect(zai?.models).toEqual([
      { id: "glm-5.3", displayName: "glm-5.3", source: "account-configuration" },
    ]);
    // A provider with no channel must not have been asked for one.
    expect(harness.routes.some((route) => route.includes("model-definitions/zai"))).toBe(false);
  });

  it("persists a strategy and membership edit and returns the pools it produced", async () => {
    const harness = poolHarness();
    const result = await runPools(harness, (gateway) =>
      gateway.updateRouting({
        strategy: "weighted-round-robin",
        accounts: [
          {
            accountId: WorkjetGatewayAccountId.make("claude-a"),
            enabled: true,
            priority: 5,
            weight: 9,
          },
          {
            accountId: WorkjetGatewayAccountId.make("claude-b"),
            enabled: true,
            priority: 0,
            weight: 3,
          },
        ],
      }),
    );
    const document = JSON.parse(harness.configuration()) as {
      routingStrategy: string;
      accounts: ReadonlyArray<{ id: string; priority: number; weight: number }>;
    };
    expect(document.routingStrategy).toBe("weighted-round-robin");
    expect(document.accounts.find((entry) => entry.id === "claude-a")).toMatchObject({
      priority: 5,
      weight: 9,
    });
    const claudePool = result.catalog.providerPools.find((pool) => pool.provider === "claude");
    expect(claudePool?.strategy).toBe("weighted-round-robin");
    expect(claudePool?.weightHonored).toBe(true);
    // Priority still gates before weight, exactly as the host's scheduler does.
    expect(claudePool?.members.map((member) => [member.accountId, member.selectable])).toEqual([
      ["claude-a", true],
      ["claude-b", false],
    ]);
    // The host runtime document carries the new strategy, not the old default.
    expect(
      harness.writes.some((entry) => entry.includes('"routing_strategy":"weighted-round-robin"')),
    ).toBe(true);
  });

  it("refuses an edit naming an account the configuration does not have", async () => {
    const harness = poolHarness();
    const failure = await runPools(harness, (gateway) =>
      gateway
        .updateRouting({
          strategy: "round-robin",
          accounts: [
            {
              accountId: WorkjetGatewayAccountId.make("claude-ghost"),
              enabled: true,
              priority: 0,
              weight: 1,
            },
          ],
        })
        .pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(WorkjetGatewayOperationError);
    expect(failure.reason).toBe("invalid-configuration");
    expect(JSON.parse(harness.configuration())).toMatchObject({ routingStrategy: "round-robin" });
  });

  it("refuses an edit that would leave the default provider with no enabled account", async () => {
    const harness = poolHarness();
    const failure = await runPools(harness, (gateway) =>
      gateway
        .updateRouting({
          strategy: "round-robin",
          accounts: [
            {
              accountId: WorkjetGatewayAccountId.make("claude-a"),
              enabled: false,
              priority: 0,
              weight: 1,
            },
            {
              accountId: WorkjetGatewayAccountId.make("claude-b"),
              enabled: false,
              priority: 0,
              weight: 1,
            },
          ],
        })
        .pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(WorkjetGatewayOperationError);
    // The edit was not applied: the host would have refused to start on it.
    // (`start()` itself persists the allocated provider port, so the document
    // is compared by content rather than byte-for-byte.)
    const document = JSON.parse(harness.configuration()) as {
      accounts: ReadonlyArray<{ id: string; enabled: boolean }>;
    };
    expect(document.accounts.every((account) => account.enabled)).toBe(true);
  });
});

/**
 * Environment-scoped credentials. Each environment runs its own server with
 * its own `stateDir`/`secretsDir`, so this asserts that a gateway reads and
 * writes only inside the environment that owns it, and that the host it spawns
 * is pointed at that environment's secret root and no other.
 */
describe("ProviderGatewayService environment scoping", () => {
  const environmentConfiguration = (id: string) =>
    JSON.stringify({
      schemaVersion: 1,
      defaultProvider: "claude",
      accounts: [
        {
          id: `claude-${id}`,
          label: `Claude ${id}`,
          provider: "claude",
          enabled: true,
          priority: 0,
          weight: 1,
          models: [],
          accessTokenSecret: { scope: "workjet-provider-gateway", name: `${id}.access` },
          refreshTokenSecret: { scope: "workjet-provider-gateway", name: `${id}.refresh` },
        },
      ],
      pools: [],
      routes: [],
    });

  const environmentHarness = (id: string) => {
    const base = readyHarness();
    const reads: Array<string> = [];
    const writes: Array<{ readonly path: string; readonly content: string }> = [];
    const secretReads: Array<string> = [];
    const platform: ProviderGatewayPlatform = {
      ...base.platform,
      // The shared harness pins the runtime path to the default state
      // directory; this suite is precisely about a different one.
      spawn: (_executable, args) => {
        expect(args).toEqual(["--config", `/environments/${id}/provider-gateway-runtime.json`]);
        return base.process;
      },
      readText: async (path) => {
        reads.push(path);
        if (path.endsWith("provider-gateway.json")) return environmentConfiguration(id);
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      writePrivateText: async (path, content) => {
        writes.push({ path, content });
      },
      managementGet: async (_endpoint, route) =>
        route.endsWith("runtime-status")
          ? { schema: "workjet.provider-gateway.runtime-status.v1" }
          : { schema: "workjet.provider-gateway.runtime-summary.v1" },
    };
    const secrets = ServerSecretStore.ServerSecretStore.of({
      get: (name: string) =>
        Effect.sync(() => {
          secretReads.push(name);
          return Option.some(new TextEncoder().encode(`${id}-secret`));
        }),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
      remove: () => Effect.void,
    });
    const config = ServerConfig.make({
      stateDir: `/environments/${id}`,
      secretsDir: `/environments/${id}/secrets`,
    } as ServerConfig.ServerConfig["Service"]);
    return { platform, secrets, config, reads, writes, secretReads };
  };

  const runEnvironment = (harness: ReturnType<typeof environmentHarness>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* make({ platform: harness.platform, executable: "/gateway-host" });
        yield* gateway.start();
        return yield* gateway.catalog();
      }),
    ).pipe(
      Effect.provideService(ServerConfig.ServerConfig, harness.config),
      Effect.provideService(ServerSecretStore.ServerSecretStore, harness.secrets),
      Effect.runPromise,
    );

  it("keeps every path, secret, and account inside the environment that owns it", async () => {
    const alpha = environmentHarness("alpha");
    const beta = environmentHarness("beta");
    const [alphaCatalog, betaCatalog] = await Promise.all([
      runEnvironment(alpha),
      runEnvironment(beta),
    ]);

    // Each gateway saw only its own accounts.
    expect(alphaCatalog.accounts.map((account) => account.id)).toEqual(["claude-alpha"]);
    expect(betaCatalog.accounts.map((account) => account.id)).toEqual(["claude-beta"]);

    for (const [own, other, harness] of [
      ["alpha", "beta", alpha],
      ["beta", "alpha", beta],
    ] as const) {
      // Every file it touched is under its own state directory.
      const paths = [...harness.reads, ...harness.writes.map((entry) => entry.path)];
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path.startsWith(`/environments/${own}/`), path).toBe(true);
        expect(path).not.toContain(`/environments/${other}/`);
      }
      // Every secret it resolved is a gateway-scoped name from its own store.
      expect(harness.secretReads.length).toBeGreaterThan(0);
      for (const name of harness.secretReads) {
        expect(name.startsWith("workjet-provider-gateway."), name).toBe(true);
      }
      // The host it spawns is pointed at its own secret root, and the rendered
      // document mentions no other environment anywhere.
      const hostDocument = harness.writes.find((entry) =>
        entry.content.includes("workjet.provider-gateway-host.v1"),
      );
      expect(hostDocument).toBeDefined();
      const rendered = JSON.parse(hostDocument!.content) as { secretRoot: string };
      expect(rendered.secretRoot).toBe(`/environments/${own}/secrets`);
      expect(hostDocument!.content).not.toContain(`/environments/${other}`);
      expect(hostDocument!.content).not.toContain(`claude-${other}`);
    }
  });
});
