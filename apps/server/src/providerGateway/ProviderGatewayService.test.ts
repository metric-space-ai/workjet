import {
  EnvironmentId,
  WorkjetComputerId,
  WorkjetConnectionId,
  WorkjetGatewayAccountId,
  WorkjetGatewayOperationError,
} from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

const decodeStoredAccounts = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ accounts: Schema.Array(Schema.Unknown) })),
);

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
    publicModelCatalog: async () => undefined,
    fingerprint: undefined,
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
  it("admits no inference or auth error for an intentionally disabled account", async () => {
    const harness = readyHarness();
    let probes = 0;
    const disabled = JSON.stringify({
      ...JSON.parse(configuration),
      accounts: JSON.parse(configuration).accounts.map((account: Record<string, unknown>) => ({
        ...account,
        enabled: false,
      })),
    });
    const platform: ProviderGatewayPlatform = {
      ...harness.platform,
      fingerprint: nodeProviderGatewayPlatform.fingerprint,
      readText: async (path) => {
        if (path.endsWith("model-checks.json"))
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return disabled;
      },
      providerModelCheck: async () => {
        ++probes;
        return { status: "ok", errorClass: null, httpStatus: 200 };
      },
    };
    const result = await runGateway(platform, (gateway) =>
      Effect.gen(function* () {
        yield* gateway.start();
        const queued = yield* gateway.checkModels({ force: true });
        expect(queued.pending).toEqual([]);
        return yield* gateway.modelChecks();
      }),
    );
    expect(probes).toBe(0);
    expect(result.checks).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(result.deferredCount).toBe(0);
    expect(harness.writes.some((value) => value.includes('"errorClass":"auth"'))).toBe(false);
  });

  it("discards a late success when its account is disabled during inference", async () => {
    const harness = readyHarness();
    let disabled = false;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const platform: ProviderGatewayPlatform = {
      ...harness.platform,
      fingerprint: nodeProviderGatewayPlatform.fingerprint,
      readText: async (path) => {
        if (path.endsWith("model-checks.json"))
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        const config = JSON.parse(configuration);
        if (disabled) config.accounts[0].enabled = false;
        return JSON.stringify(config);
      },
      managementGet: async (endpoint, route, key, maximumBytes) =>
        route.endsWith("runtime-status")
          ? {
              schema: "workjet.provider-gateway.runtime-status.v1",
              features: { account_selection: true },
            }
          : harness.platform.managementGet(endpoint, route, key, maximumBytes),
      providerModelCheck: async (_endpoint, _provider, _accountId, _modelId, signal) => {
        started();
        await new Promise<void>((resolve) =>
          signal?.addEventListener(
            "abort",
            () => {
              cancelled();
              resolve();
            },
            { once: true },
          ),
        );
        return { status: "ok", errorClass: null, httpStatus: 200 };
      },
    };
    const result = await runGateway(platform, (gateway) =>
      Effect.gen(function* () {
        yield* gateway.start();
        yield* gateway.checkModels({});
        yield* Effect.promise(() => began);
        disabled = true;
        const snapshot = yield* gateway.modelChecks();
        yield* Effect.promise(() => cancellation);
        return snapshot;
      }),
    );
    expect(result.pending).toEqual([]);
    expect(result.checks).toEqual([]);
    expect(harness.writes.some((value) => value.includes('"status":"ok"'))).toBe(false);
  });

  it("makes no inference request without the native account-selection capability", async () => {
    const harness = readyHarness();
    let probes = 0;
    let persist!: () => void;
    const persisted = new Promise<void>((resolve) => {
      persist = resolve;
    });
    const platform: ProviderGatewayPlatform = {
      ...harness.platform,
      fingerprint: nodeProviderGatewayPlatform.fingerprint,
      writePrivateText: async (path, content) => {
        await harness.platform.writePrivateText(path, content);
        if (path.endsWith("model-checks.json")) persist();
      },
      providerModelCheck: async () => {
        ++probes;
        return { status: "ok", errorClass: null, httpStatus: 200 };
      },
      readText: async (path, limit) => {
        if (path.endsWith("model-checks.json"))
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return harness.platform.readText(path, limit);
      },
    };
    const result = await runGateway(platform, (gateway) =>
      Effect.gen(function* () {
        yield* gateway.start();
        const queued = yield* gateway.checkModels({});
        expect(queued.pending).toHaveLength(1);
        yield* Effect.promise(() => persisted);
        return yield* gateway.modelChecks();
      }),
    );
    expect(probes).toBe(0);
    expect(result.checks[0]).toMatchObject({
      status: "unavailable",
      source: "gateway",
      errorClass: null,
      httpStatus: null,
      unavailableReason: "exact-account-unavailable",
    });
  });
  it("reads durable environment usage while the host is stopped and never starts it", async () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    const day = Math.floor(now / 86_400_000);
    const platform: ProviderGatewayPlatform = {
      ...nodeProviderGatewayPlatform,
      now: () => now,
      spawn: () => {
        throw new Error("must not spawn");
      },
      readText: async (path) => {
        if (path === `/state/provider-gateway-usage/${day}.jsonl`)
          return `${JSON.stringify({ completedAtMs: now - 1000, provider: "codex", model: "gpt-6", modelSource: "response", error: false, inputTokens: 7, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null })}\n`;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    };
    const result = await runGateway(platform, (gateway) =>
      gateway.usage({ days: 7, timeZone: "Europe/Berlin" }),
    );
    expect(result.totals.requests).toBe(1);
    expect(result.totals.inputTokens).toBe(7);
    expect(result.timeZone).toBe("Europe/Berlin");
  });

  it("reports usage-specific query and storage failures", async () => {
    const platform: ProviderGatewayPlatform = {
      ...nodeProviderGatewayPlatform,
      readText: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    };
    const query = await runGateway(platform, (gateway) =>
      gateway.usage({ days: 7, timeZone: "Invalid/Zone" }).pipe(Effect.flip),
    );
    expect(query.reason).toBe("invalid-usage-query");
    const storage = await runGateway(platform, (gateway) =>
      gateway.usage({ days: 7 }).pipe(Effect.flip),
    );
    expect(storage.reason).toBe("usage-unavailable");
  });
  it("persists a scoped grant without copying credentials to another computer", async () => {
    const files = new Map<string, string>([["/state/provider-gateway.json", configuration]]);
    const platform: ProviderGatewayPlatform = {
      ...nodeProviderGatewayPlatform,
      readText: async (path) => {
        const content = files.get(path);
        if (content !== undefined) return content;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      writePrivateText: async (path, content) => {
        files.set(path, content);
      },
    };
    const accountId = WorkjetGatewayAccountId.make("codex-primary");
    const firstTarget = {
      connectionId: WorkjetConnectionId.make("ctox-welsch"),
      instanceId: "welsch",
      computerId: WorkjetComputerId.make("gpu1-a6000"),
    };
    const secondTarget = {
      ...firstTarget,
      computerId: WorkjetComputerId.make("gpu3-a4500"),
    };
    const environmentId = EnvironmentId.make("gateway-host");
    await runGateway(platform, (gateway) =>
      Effect.gen(function* () {
        expect((yield* gateway.scopedCatalog(firstTarget, environmentId)).accounts).toEqual([]);
        yield* gateway.setGrant({ target: firstTarget, accountId, granted: true });
        expect(
          (yield* gateway.scopedCatalog(firstTarget, environmentId)).accounts[0]?.credentialRef,
        ).toEqual({ environmentId, accountId });
        expect((yield* gateway.scopedCatalog(secondTarget, environmentId)).accounts).toEqual([]);
      }),
    );
    expect(files.get("/state/provider-gateway-grants.json")).not.toContain("provider-secret");
    await runGateway(platform, (gateway) =>
      Effect.gen(function* () {
        expect((yield* gateway.scopedCatalog(firstTarget, environmentId)).accounts).toHaveLength(1);
        yield* gateway.setGrant({ target: firstTarget, accountId, granted: false });
        expect((yield* gateway.scopedCatalog(firstTarget, environmentId)).accounts).toEqual([]);
      }),
    );
  });

  it("revokes persisted grants when their gateway account is removed", async () => {
    const harness = readyHarness();
    const files = new Map<string, string>([["/state/provider-gateway.json", configuration]]);
    const platform: ProviderGatewayPlatform = {
      ...harness.platform,
      readText: async (path) => {
        const content = files.get(path);
        if (content !== undefined) return content;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      writePrivateText: async (path, content) => {
        files.set(path, content);
      },
    };
    const target = {
      connectionId: WorkjetConnectionId.make("ctox-welsch"),
      instanceId: "welsch",
      computerId: WorkjetComputerId.make("gpu1-a6000"),
    };
    const accountId = WorkjetGatewayAccountId.make("codex-primary");
    await runGateway(platform, (gateway) =>
      Effect.gen(function* () {
        yield* gateway.setGrant({ target, accountId, granted: true });
        yield* gateway.removeAccount({ accountId });
        expect(
          (yield* gateway.scopedCatalog(target, EnvironmentId.make("gateway-host"))).accounts,
        ).toEqual([]);
      }),
    );
    expect(JSON.parse(files.get("/state/provider-gateway-grants.json") ?? "null")).toEqual({
      schemaVersion: 1,
      grants: [],
    });
  });

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

  it.each([false, true])(
    "runs begin, poll, claim, persist, and reload (targeted re-login: %s)",
    async (targeted) => {
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
            const written = writes.findLast((entry) =>
              entry.path.endsWith("provider-gateway.json"),
            );
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
                  credentials: [
                    { id: "codex:acct", provider: "codex", label: "user@example.test" },
                  ],
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
          const session = yield* gateway.oauthStart({
            provider: "codex",
            ...(targeted ? { accountId: WorkjetGatewayAccountId.make("codex-primary") } : {}),
          });
          expect(session.state).toBe("state-1");
          expect(session.authorizationUrl.startsWith("https://")).toBe(true);
          const first = yield* gateway.oauthPoll({ state: session.state });
          expect(first.pending).toBe(true);
          const second = yield* gateway.oauthPoll({ state: session.state });
          expect(second.pending).toBe(false);
          expect(second.failed).toBe(false);
          expect(second.completedAccountIds).toEqual([
            targeted ? "codex-primary" : "codex-user-example.test",
          ]);
        }),
      ).pipe(
        Effect.provideService(ServerConfig.ServerConfig, testConfig),
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
        Effect.runPromise,
      );

      expect(claims).toEqual(["POST /v0/management/oauth/session/state-1/claim"]);
      expect(
        storedSecrets.get(
          targeted
            ? "workjet-provider-gateway.codex.access"
            : "workjet-provider-gateway.account-codex-user-example.test-access-token",
        ),
      ).toBe("access-token-material");
      expect(
        storedSecrets.get(
          targeted
            ? "workjet-provider-gateway.codex.id"
            : "workjet-provider-gateway.account-codex-user-example.test-id-token",
        ),
      ).toBe("id-token-material");
      expect(
        storedSecrets.get(
          targeted
            ? "workjet-provider-gateway.codex.refresh"
            : "workjet-provider-gateway.account-codex-user-example.test-refresh-token",
        ),
      ).toBe("refresh-token-material");
      const configWrite = writes.findLast((entry) => entry.path.endsWith("provider-gateway.json"));
      expect(configWrite).toBeDefined();
      expect(configWrite?.content).toContain(
        targeted ? '"codex-primary"' : '"codex-user-example.test"',
      );
      if (!targeted) {
        const persisted = JSON.parse(configWrite!.content);
        const added = persisted.accounts.find(
          (account: { readonly id: string }) => account.id === "codex-user-example.test",
        );
        expect(added.models).toEqual([]);
        expect(configWrite?.content).not.toContain("*");
      }
      if (targeted) {
        const persisted = JSON.parse(configWrite!.content);
        expect(persisted.accounts).toHaveLength(1);
        expect(persisted.accounts[0]).toMatchObject({
          id: "codex-primary",
          label: "Primary Codex",
          models: ["gpt-test"],
        });
      }
      expect(configWrite?.content).not.toContain("access-token-material");
      expect(configWrite?.content).not.toContain("refresh-token-material");
      // The login reloads the gateway so the new account is served.
      expect(spawnCount).toBe(2);
    },
  );

  it("rechecks xAI immediately after same-token re-login and reloads the old cooldown away", async () => {
    const accountId = WorkjetGatewayAccountId.make("xai-primary");
    const config = JSON.stringify({
      schemaVersion: 1,
      defaultProvider: "xai",
      accounts: [
        {
          id: accountId,
          provider: "xai",
          label: "Xai account",
          enabled: true,
          models: ["grok-4.7"],
          priority: 3,
          weight: 1,
          accessTokenSecret: { scope: "workjet-provider-gateway", name: "xai.access" },
          refreshTokenSecret: { scope: "workjet-provider-gateway", name: "xai.refresh" },
        },
      ],
      pools: [],
      routes: [],
    });
    const files = new Map<string, string>([["/state/provider-gateway.json", config]]);
    let spawnCount = 0;
    let checks = 0;
    let firstRecorded!: () => void;
    let freshRecorded!: () => void;
    const first = new Promise<void>((resolve) => {
      firstRecorded = resolve;
    });
    const fresh = new Promise<void>((resolve) => {
      freshRecorded = resolve;
    });
    const platform: ProviderGatewayPlatform = {
      ...nodeProviderGatewayPlatform,
      readText: async (path) => {
        const value = files.get(path);
        if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return value;
      },
      writePrivateText: async (path, content) => {
        files.set(path, content);
        if (path.endsWith("provider-gateway-model-checks.json")) {
          const entry = JSON.parse(content).entries.find(
            (item: { check: { accountId: string } }) => item.check.accountId === accountId,
          );
          if (entry?.check.status === "error") firstRecorded();
          if (entry?.check.status === "ok") freshRecorded();
        }
      },
      remove: async (path) => {
        files.delete(path);
      },
      spawn: () => {
        spawnCount++;
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
      },
      managementGet: async (_endpoint, route) => {
        if (route.endsWith("xai-auth-url"))
          return {
            provider: "xai",
            state: "xai-login",
            authorization_url: "https://auth.x.ai/device",
          };
        if (route.startsWith("/v0/management/oauth/status"))
          return {
            pending: false,
            error: null,
            credentials: [{ id: accountId, provider: "xai", label: "Xai account" }],
          };
        return route.endsWith("runtime-status")
          ? {
              schema: "workjet.provider-gateway.runtime-status.v1",
              features: { account_selection: true },
            }
          : { schema: "workjet.provider-gateway.runtime-summary.v1" };
      },
      managementRequest: async () => ({
        credentials: [
          {
            account: {
              id: accountId,
              auth_index: "xai",
              label: "Xai account",
              provider: "xai",
              disabled: false,
              models: ["grok-4.7"],
            },
            // The provider may return the same token; login success must still bypass old checks.
            secrets: {
              access_token_secret: "provider-secret",
              refresh_token_secret: "provider-secret",
            },
          },
        ],
      }),
      providerModelCheck: async (_endpoint, provider, selectedAccountId, modelId) => {
        expect(provider).toBe("xai");
        expect(selectedAccountId).toBe(accountId);
        expect(modelId).toBe("grok-4.7");
        checks++;
        return spawnCount === 1
          ? { status: "error", source: "upstream", errorClass: "auth", httpStatus: 401 }
          : { status: "ok", source: "upstream", errorClass: null, httpStatus: 200 };
      },
    };
    await runGateway(platform, (gateway) =>
      Effect.gen(function* () {
        yield* gateway.start();
        yield* gateway.checkModels({ accountId, force: true });
        yield* Effect.promise(() => first);
        expect((yield* gateway.modelChecks()).checks[0]?.errorClass).toBe("auth");
        const session = yield* gateway.oauthStart({ provider: "xai", accountId });
        const result = yield* gateway.oauthPoll({ state: session.state });
        expect(result.completedAccountIds).toEqual([accountId]);
        yield* Effect.promise(() => fresh);
        expect((yield* gateway.modelChecks()).checks[0]).toMatchObject({
          status: "ok",
          errorClass: null,
        });
        const saved = yield* decodeStoredAccounts(files.get("/state/provider-gateway.json")!);
        expect(saved.accounts).toHaveLength(1);
        expect(saved.accounts[0]).toMatchObject({
          id: accountId,
          priority: 3,
          models: ["grok-4.7"],
        });
      }),
    );
    expect(spawnCount).toBe(2);
    expect(checks).toBe(2);
  });

  it("reports a failed login without claiming credentials", async () => {
    const harness = readyHarness();
    const platform: ProviderGatewayPlatform = {
      ...harness.platform,
      managementGet: async (endpoint, route, key, maximumBytes) => {
        if (route.endsWith("-auth-url"))
          return { state: "state-x", authorization_url: "https://auth.example/authorize" };
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
        const session = yield* gateway.oauthStart({ provider: "codex" });
        const result = yield* gateway.oauthPoll({ state: session.state });
        expect(result.failed).toBe(true);
        expect(result.completedAccountIds).toEqual([]);
      }),
    );
  });

  it.each(["unknown", "expired", "cancelled"] as const)(
    "rejects %s OAuth bindings before polling or claiming",
    async (kind) => {
      const harness = readyHarness();
      let now = 1_700_000_000_000;
      let begins = 0;
      const claims: string[] = [];
      const platform: ProviderGatewayPlatform = {
        ...harness.platform,
        now: () => now,
        managementGet: async (endpoint, route, key, maximumBytes) => {
          if (route.endsWith("-auth-url"))
            return {
              state: `state-${++begins}`,
              authorization_url: "https://auth.example/authorize",
            };
          if (route.startsWith("/v0/management/oauth/status"))
            throw new Error("invalid session must not reach the host");
          return harness.platform.managementGet(endpoint, route, key, maximumBytes);
        },
        managementRequest: async (_endpoint, route, _key, method) => {
          claims.push(`${method} ${route}`);
          return {};
        },
      };
      await runGateway(platform, (gateway) =>
        Effect.gen(function* () {
          yield* gateway.start();
          const session = yield* gateway.oauthStart({
            provider: "codex",
            accountId: WorkjetGatewayAccountId.make("codex-primary"),
          });
          if (kind === "expired") {
            now += 10 * 60_000;
            // A second start prunes the expired binding: the stale poll must still
            // fail rather than being interpreted as an add-account operation.
            yield* gateway.oauthStart({ provider: "codex" });
          } else if (kind === "cancelled") yield* gateway.oauthCancel({ state: session.state });
          const failure = yield* gateway
            .oauthPoll({ state: kind === "unknown" ? "foreign-state" : session.state })
            .pipe(Effect.flip);
          expect(failure.reason).toBe("oauth-session-invalid");
        }),
      );
      expect(claims.every((claim) => claim.startsWith("DELETE "))).toBe(true);
    },
  );

  it("rejects a credential claim from a different provider than the bound OAuth session", async () => {
    const harness = readyHarness();
    const platform: ProviderGatewayPlatform = {
      ...harness.platform,
      managementGet: async (endpoint, route, key, maximumBytes) => {
        if (route.endsWith("-auth-url"))
          return { state: "bound-state", authorization_url: "https://auth.example/authorize" };
        if (route.startsWith("/v0/management/oauth/status"))
          return { pending: false, credentials: [{}] };
        return harness.platform.managementGet(endpoint, route, key, maximumBytes);
      },
      managementRequest: async () => ({
        credentials: [
          {
            account: { provider: "claude", label: "account@example.test", models: [] },
            secrets: { access_token_secret: "fake-access", refresh_token_secret: "fake-refresh" },
          },
        ],
      }),
    };
    await runGateway(platform, (gateway) =>
      Effect.gen(function* () {
        yield* gateway.start();
        const session = yield* gateway.oauthStart({ provider: "codex" });
        const failure = yield* gateway.oauthPoll({ state: session.state }).pipe(Effect.flip);
        expect(failure.reason).toBe("oauth-session-invalid");
      }),
    );
    expect(harness.writes.join("\n")).not.toContain("account@example.test");
  });

  it.each(["secret", "configuration"] as const)(
    "restores existing OAuth credentials when %s persistence fails",
    async (failureAt) => {
      const harness = readyHarness();
      const original = new Map([
        ["workjet-provider-gateway.codex.id", "old-id"],
        ["workjet-provider-gateway.codex.access", "old-access"],
        ["workjet-provider-gateway.codex.refresh", "old-refresh"],
      ]);
      const stored = new Map(original);
      let claimStarted = false;
      let failSecretOnce = true;
      const store = ServerSecretStore.ServerSecretStore.of({
        get: (name) =>
          Effect.succeed(
            stored.has(name)
              ? Option.some(new TextEncoder().encode(stored.get(name)!))
              : Option.none(),
          ),
        set: (name, value) =>
          Effect.sync(() => {
            if (
              claimStarted &&
              failureAt === "secret" &&
              name.endsWith("codex.refresh") &&
              failSecretOnce
            ) {
              failSecretOnce = false;
              throw new Error("fixture write failure");
            }
            stored.set(name, new TextDecoder().decode(value));
          }),
        create: () => Effect.void,
        remove: (name) =>
          Effect.sync(() => {
            stored.delete(name);
          }),
        getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
      });
      const platform: ProviderGatewayPlatform = {
        ...harness.platform,
        writePrivateText: async (path, content) => {
          if (
            claimStarted &&
            failureAt === "configuration" &&
            path.endsWith("provider-gateway.json")
          )
            throw new Error("fixture config failure");
          await harness.platform.writePrivateText(path, content);
        },
        managementGet: async (endpoint, route, key, maximumBytes) => {
          if (route.endsWith("-auth-url"))
            return { state: "replace-state", authorization_url: "https://auth.example/authorize" };
          if (route.startsWith("/v0/management/oauth/status"))
            return { pending: false, credentials: [{}] };
          return harness.platform.managementGet(endpoint, route, key, maximumBytes);
        },
        managementRequest: async () => ({
          credentials: [
            {
              account: { provider: "codex", label: "Fixture", models: [] },
              secrets: {
                id_token_secret: "new-id",
                access_token_secret: "new-access",
                refresh_token_secret: "new-refresh",
              },
            },
          ],
        }),
      };
      await Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* make({ platform, executable: "/gateway-host" });
          yield* gateway.start();
          const session = yield* gateway.oauthStart({
            provider: "codex",
            accountId: WorkjetGatewayAccountId.make("codex-primary"),
          });
          claimStarted = true;
          const failure = yield* gateway.oauthPoll({ state: session.state }).pipe(Effect.flip);
          expect(failure.reason).toBe(
            failureAt === "secret" ? "secret-unavailable" : "invalid-configuration",
          );
          expect(stored).toEqual(original);
          expect(harness.spawnCount()).toBe(1);
        }),
      ).pipe(
        Effect.provideService(ServerConfig.ServerConfig, testConfig),
        Effect.provideService(ServerSecretStore.ServerSecretStore, store),
        Effect.runPromise,
      );
    },
  );

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
    const platform: ProviderGatewayPlatform = {
      ...base.platform,
      discoverKimiConnection: async () => ({
        plan: "coding",
        upstreamBaseUrl: "https://api.kimi.com/coding/v1",
        models: ["k3"],
      }),
    };
    return { ...base, platform, storedSecrets, secrets };
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

  it("stores the accepted Z.ai plan with only its selected live model", async () => {
    const harness = apiKeyHarness();
    const model = "glm-5.3-flash"; // Real account GET /models, 2026-10-09.
    harness.platform = {
      ...harness.platform,
      publicModelCatalog: async () => ({
        schemaVersion: 1,
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(harness.platform.now())),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(harness.platform.now() + 60_000)),
        providers: [{ provider: "zai", status: "observed", models: [model] }],
      }),
      discoverZaiConnection: async (_key, preferredModels) => {
        expect(preferredModels).toEqual([model]);
        return {
          upstreamBaseUrl: "https://api.z.ai/api/coding/paas/v4",
          models: [model],
          probeModel: model,
        };
      },
    };
    await runWithSecrets(harness, (gateway) =>
      gateway.addApiKeyAccount({
        provider: "zai",
        label: "Coding plan",
        apiKey: API_KEY,
        models: [],
      }),
    );
    const stored = JSON.parse(harness.writes.find((entry) => entry.includes("apiKeySecret"))!);
    expect(
      stored.accounts.find((entry: { provider: string }) => entry.provider === "zai"),
    ).toMatchObject({
      upstreamBaseUrl: "https://api.z.ai/api/coding/paas/v4",
      models: [model],
    });
    expect(harness.writes.join("\n")).not.toContain(API_KEY);
  });

  it.each(["accepted", "unavailable", "disabled", "other-account", "custom", "coding"] as const)(
    "repairs only a verified legacy Z.ai binding (%s)",
    async (mode) => {
      const harness = apiKeyHarness();
      const model = "glm-5.3-flash"; // Real account GET /models, 2026-10-09.
      const account = {
        id: "zai-existing",
        provider: "zai",
        label: "Existing plan",
        enabled: mode !== "disabled",
        priority: 7,
        weight: 1,
        models: [model],
        apiKeySecret: { scope: "workjet-provider-gateway", name: "existing-key" },
        ...(mode === "custom"
          ? { upstreamBaseUrl: "https://other.example/v1" }
          : mode === "coding"
            ? { upstreamBaseUrl: "https://api.z.ai/api/coding/paas/v4" }
            : {}),
      };
      let document = JSON.stringify({
        ...JSON.parse(configuration),
        accounts: [...JSON.parse(configuration).accounts, account],
      });
      let discoveries = 0;
      const writer = harness.platform.writePrivateText;
      harness.platform = {
        ...harness.platform,
        discoverZaiConnection: async (key, models, origin) => {
          discoveries += 1;
          expect(key).toBe("provider-secret");
          expect(models).toEqual([model]);
          expect(origin).toBe("https://api.z.ai/api/paas/v4");
          return mode === "unavailable"
            ? undefined
            : {
                upstreamBaseUrl: "https://api.z.ai/api/coding/paas/v4",
                models: [model],
                probeModel: model,
              };
        },
        readText: async (path) => {
          if (path.endsWith("model-checks.json"))
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return document;
        },
        writePrivateText: async (path, value) => {
          await writer(path, value);
          if (path.endsWith("/provider-gateway.json")) document = value;
        },
      };
      await runWithSecrets(harness, (gateway) =>
        gateway.checkModels({
          force: true,
          ...(mode === "other-account"
            ? { accountId: WorkjetGatewayAccountId.make("codex-primary") }
            : {}),
        }),
      );
      expect(
        JSON.parse(document).accounts.find((item: { id: string }) => item.id === account.id),
      ).toEqual({
        ...account,
        ...(mode === "accepted" ? { upstreamBaseUrl: "https://api.z.ai/api/coding/paas/v4" } : {}),
      });
      expect(discoveries).toBe(mode === "accepted" || mode === "unavailable" ? 1 : 0);
      expect(harness.storedSecrets.size).toBe(0);
      expect(document).not.toContain("provider-secret");
    },
  );

  it("stores the verified Kimi origin and live IDs on account creation", async () => {
    const harness = apiKeyHarness();
    await runWithSecrets(harness, (gateway) =>
      gateway.addApiKeyAccount({
        provider: "kimi",
        label: "Coding plan",
        apiKey: API_KEY,
        models: [],
      }),
    );
    const stored = JSON.parse(harness.writes.find((entry) => entry.includes("apiKeySecret"))!);
    expect(
      stored.accounts.find((account: { provider: string }) => account.provider === "kimi"),
    ).toMatchObject({
      upstreamBaseUrl: "https://api.kimi.com/coding/v1",
      kimiPlan: "coding",
      models: ["k3"],
    });
    expect(harness.writes.join("\n")).not.toContain(API_KEY);
  });

  it("retains a live model selection when replacing a Kimi key with no model input", async () => {
    const harness = apiKeyHarness();
    const account = {
      id: "kimi-stable",
      provider: "kimi",
      label: "Coding plan",
      enabled: false,
      priority: 7,
      weight: 1,
      upstreamBaseUrl: "https://api.kimi.com/coding/v1" as const,
      models: ["kimi-for-coding"],
      apiKeySecret: { scope: "workjet-provider-gateway", name: "existing-key" },
      credentialSuffix: "old1",
    };
    harness.platform = {
      ...harness.platform,
      readText: async () =>
        JSON.stringify({
          ...JSON.parse(configuration),
          accounts: [...JSON.parse(configuration).accounts, account],
        }),
      discoverKimiConnection: async () => ({
        plan: "coding",
        upstreamBaseUrl: account.upstreamBaseUrl,
        models: ["k3", "kimi-for-coding"],
      }),
    };
    const result = await runWithSecrets(harness, (gateway) =>
      gateway.addApiKeyAccount({
        accountId: WorkjetGatewayAccountId.make(account.id),
        provider: "kimi",
        label: account.label,
        apiKey: API_KEY,
        models: [],
      }),
    );
    expect(result.accountId).toBe(account.id);
    const stored = JSON.parse(harness.writes.find((entry) => entry.includes("apiKeySecret"))!);
    expect(stored.accounts.find((entry: { id: string }) => entry.id === account.id)).toEqual({
      ...account,
      kimiPlan: "coding",
      credentialSuffix: "abcd",
    });
    expect(harness.storedSecrets.get("workjet-provider-gateway.existing-key")).toBe(API_KEY);
    expect(harness.writes.join("\n")).not.toContain(API_KEY);
  });

  it.each([undefined, "https://api.moonshot.ai/v1"])(
    "repairs a legacy Kimi origin %s on Check all without replacing its secret or identity",
    async (upstreamBaseUrl) => {
      const harness = apiKeyHarness();
      const account = {
        id: "kimi-existing",
        provider: "kimi",
        label: "Existing coding plan",
        upstreamBaseUrl,
        enabled: true,
        priority: 7,
        weight: 1,
        models: ["kimi-for-coding"],
        apiKeySecret: { scope: "workjet-provider-gateway", name: "existing-key" },
        credentialSuffix: "old1",
      };
      let document = JSON.stringify({
        ...JSON.parse(configuration),
        accounts: [...JSON.parse(configuration).accounts, account],
      });
      const writer = harness.platform.writePrivateText;
      harness.platform = {
        ...harness.platform,
        readText: async (path) => {
          if (path.endsWith("model-checks.json"))
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return document;
        },
        writePrivateText: async (path, value) => {
          await writer(path, value);
          if (path.endsWith("/provider-gateway.json")) document = value;
        },
      };
      await runWithSecrets(harness, (gateway) => gateway.checkModels({ force: true }));
      expect(
        JSON.parse(document).accounts.find((item: { id: string }) => item.id === account.id),
      ).toEqual({
        ...account,
        upstreamBaseUrl: "https://api.kimi.com/coding/v1",
        kimiPlan: "coding",
        models: ["k3"],
      });
      expect(harness.storedSecrets.size).toBe(0);
      expect(document).not.toContain("provider-secret");
    },
  );

  it.each(["observed", "unavailable", "disabled", "other-account"] as const)(
    "repairs Claude spelling from its live account without enabling it (%s)",
    async (mode) => {
      const harness = apiKeyHarness();
      const model = "claude-opus-5-5";
      const legacy = model.replace(/-(\d+)$/, ".$1");
      const account = {
        id: "claude-existing",
        provider: "claude",
        label: "Existing account",
        enabled: mode !== "disabled",
        priority: 7,
        weight: 1,
        models: [legacy],
        accessTokenSecret: { scope: "workjet-provider-gateway", name: "existing-access" },
        refreshTokenSecret: { scope: "workjet-provider-gateway", name: "existing-refresh" },
      };
      let document = JSON.stringify({ ...JSON.parse(configuration), accounts: [account] });
      let discoveries = 0;
      const writer = harness.platform.writePrivateText;
      harness.platform = {
        ...harness.platform,
        discoverClaudeModels: async () => {
          discoveries += 1;
          return mode === "unavailable" ? undefined : [model];
        },
        readText: async (path) => {
          if (path.endsWith("model-checks.json"))
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return document;
        },
        writePrivateText: async (path, value) => {
          await writer(path, value);
          if (path.endsWith("/provider-gateway.json")) document = value;
        },
      };
      const result = await runWithSecrets(harness, (gateway) =>
        gateway.checkModels({
          force: true,
          ...(mode === "other-account"
            ? { accountId: WorkjetGatewayAccountId.make("codex-primary") }
            : {}),
        }),
      );
      if (mode === "disabled") expect(result.pending).toEqual([]);
      expect(JSON.parse(document).accounts).toEqual([
        { ...account, models: [mode === "observed" || mode === "disabled" ? model : legacy] },
      ]);
      expect(discoveries).toBe(mode === "other-account" ? 0 : 1);
      expect(harness.storedSecrets.size).toBe(0);
      expect(document).not.toContain("provider-secret");
    },
  );

  it.each(["enabled", "disabled"] as const)(
    "repairs a Claude model edit before persistence without changing the %s account",
    async (mode) => {
      for (const discovery of ["live", "unavailable", "other-model", "failed"] as const) {
        const harness = apiKeyHarness();
        // Authenticated account GET /models evidence, 2026-10-08.
        const model = "claude-opus-5-5";
        const legacy = model.replace(/-(\d+)$/, ".$1");
        const account = {
          id: "claude-existing",
          provider: "claude",
          label: "Existing account",
          enabled: mode === "enabled",
          priority: 7,
          weight: 1,
          models: [model],
          accessTokenSecret: { scope: "workjet-provider-gateway", name: "existing-access" },
          refreshTokenSecret: { scope: "workjet-provider-gateway", name: "existing-refresh" },
        };
        let document = JSON.stringify({ ...JSON.parse(configuration), accounts: [account] });
        let discoveries = 0;
        const writer = harness.platform.writePrivateText;
        harness.platform = {
          ...harness.platform,
          discoverClaudeModels: async (_token, signal) => {
            discoveries += 1;
            expect(signal?.aborted).toBe(false);
            if (discovery === "failed") throw new Error("transport failed");
            return discovery === "unavailable"
              ? undefined
              : discovery === "other-model"
                ? ["claude-sonnet-5-5"]
                : [model];
          },
          readText: async (path) => {
            if (path.endsWith("model-checks.json"))
              throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return document;
          },
          writePrivateText: async (path, value) => {
            await writer(path, value);
            if (path.endsWith("/provider-gateway.json")) document = value;
          },
        };
        const result = await runWithSecrets(harness, (gateway) =>
          gateway.updateRouting({
            strategy: "fill-first",
            accounts: [
              {
                accountId: WorkjetGatewayAccountId.make(account.id),
                enabled: account.enabled,
                priority: account.priority,
                weight: account.weight,
                models: [legacy],
              },
            ],
          }),
        );
        const expected = discovery === "live" ? model : legacy;
        expect(JSON.parse(document).accounts).toEqual([{ ...account, models: [expected] }]);
        expect(result.catalog.accounts[0]?.modelIds).toEqual([expected]);
        expect(discoveries).toBe(1);
        expect(harness.storedSecrets.size).toBe(0);
        expect(document).not.toContain("provider-secret");
      }
    },
  );

  it("does not discover or change a disabled Kimi account during Check all", async () => {
    const harness = apiKeyHarness();
    let discoveries = 0;
    const document = JSON.stringify({
      ...JSON.parse(configuration),
      accounts: [
        {
          id: "kimi-disabled",
          provider: "kimi",
          label: "Disabled",
          enabled: false,
          priority: 0,
          weight: 1,
          models: ["k3"],
          apiKeySecret: { scope: "workjet-provider-gateway", name: "existing-key" },
        },
      ],
    });
    harness.platform = {
      ...harness.platform,
      readText: async (path) => {
        if (path.endsWith("model-checks.json"))
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return document;
      },
      discoverKimiConnection: async () => {
        discoveries += 1;
        return undefined;
      },
    };
    const result = await runWithSecrets(harness, (gateway) => gateway.checkModels({ force: true }));
    expect(result.pending).toEqual([]);
    expect(discoveries).toBe(0);
    expect(harness.writes).toEqual([]);
    expect(harness.storedSecrets.size).toBe(0);
  });

  it("adds plan metadata to an accepted existing Coding endpoint without changing its selection or secret", async () => {
    const harness = apiKeyHarness();
    const account = {
      id: "kimi-existing",
      provider: "kimi",
      label: "Coding work",
      enabled: true,
      priority: 7,
      weight: 1,
      models: ["kimi-for-coding"],
      upstreamBaseUrl: "https://api.kimi.com/coding/v1",
      apiKeySecret: { scope: "workjet-provider-gateway", name: "existing-key" },
      credentialSuffix: "old1",
    };
    let document = JSON.stringify({
      ...JSON.parse(configuration),
      providerPort: 41000,
      accounts: [account],
    });
    const writer = harness.platform.writePrivateText;
    harness.platform = {
      ...harness.platform,
      discoverKimiConnection: async () => ({
        plan: "coding",
        upstreamBaseUrl: "https://api.kimi.com/coding/v1",
        models: ["k3", "kimi-for-coding"],
      }),
      readText: async (path) => {
        if (path.endsWith("model-checks.json"))
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return document;
      },
      writePrivateText: async (path, value) => {
        await writer(path, value);
        if (path.endsWith("/provider-gateway.json")) document = value;
      },
    };
    const catalog = await runWithSecrets(harness, (gateway) =>
      Effect.gen(function* () {
        yield* gateway.checkModels({ force: true });
        yield* gateway.checkModels({ force: true });
        return yield* gateway.catalog();
      }),
    );
    expect(JSON.parse(document).accounts).toEqual([{ ...account, kimiPlan: "coding" }]);
    expect(catalog.accounts[0]?.kimiConnection).toEqual({
      plan: "coding",
      upstreamBaseUrl: account.upstreamBaseUrl,
    });
    expect(harness.storedSecrets.size).toBe(0);
    expect(harness.writes.filter((value) => value.includes('"kimiPlan"'))).toHaveLength(1);
  });

  it("persists the accepted regional API plan without a user choice", async () => {
    const harness = apiKeyHarness();
    harness.platform = {
      ...harness.platform,
      discoverKimiConnection: async () => ({
        plan: "api",
        upstreamBaseUrl: "https://api.moonshot.cn/v1",
        models: ["k3"],
      }),
    };
    await runWithSecrets(harness, (gateway) =>
      gateway.addApiKeyAccount({
        provider: "kimi",
        label: "API work",
        apiKey: API_KEY,
      }),
    );
    const stored = JSON.parse(harness.writes.find((value) => value.includes("apiKeySecret"))!);
    expect(
      stored.accounts.find((account: { provider: string }) => account.provider === "kimi"),
    ).toMatchObject({
      kimiPlan: "api",
      upstreamBaseUrl: "https://api.moonshot.cn/v1",
      models: ["k3"],
    });
    expect(harness.writes.join("\n")).not.toContain(API_KEY);
  });

  it("preserves the existing account and secret when a replacement Kimi key is not accepted", async () => {
    const harness = apiKeyHarness();
    const account = {
      id: "kimi-existing",
      provider: "kimi",
      label: "Coding work",
      enabled: false,
      priority: 7,
      weight: 1,
      models: ["kimi-for-coding"],
      kimiPlan: "coding",
      upstreamBaseUrl: "https://api.kimi.com/coding/v1",
      apiKeySecret: { scope: "workjet-provider-gateway", name: "existing-key" },
      credentialSuffix: "old1",
    };
    const document = JSON.stringify({ ...JSON.parse(configuration), accounts: [account] });
    harness.platform = {
      ...harness.platform,
      readText: async () => document,
      discoverKimiConnection: async () => undefined,
    };
    const error = await runWithSecrets(harness, (gateway) =>
      gateway
        .addApiKeyAccount({
          provider: "kimi",
          accountId: WorkjetGatewayAccountId.make(account.id),
          label: account.label,
          apiKey: API_KEY,
        })
        .pipe(Effect.flip),
    );
    expect(error.reason).toBe("kimi-key-not-accepted");
    expect(error.message).not.toContain(API_KEY);
    expect(harness.storedSecrets.size).toBe(0);
    expect(harness.writes).toEqual([]);
  });

  it("does not persist a Kimi key when no official endpoint returns a live list", async () => {
    const harness = apiKeyHarness();
    harness.platform = { ...harness.platform, discoverKimiConnection: async () => undefined };
    const error = await runWithSecrets(harness, (gateway) =>
      gateway
        .addApiKeyAccount({ provider: "kimi", label: "Coding plan", apiKey: API_KEY })
        .pipe(Effect.flip),
    );
    expect(error.reason).toBe("kimi-key-not-accepted");
    expect(error.message).toContain("https://api.kimi.com/coding/v1");
    expect(error.message).toContain("https://api.kimi.ai/coding/v1");
    expect(error.message).toContain("https://api.moonshot.ai/v1");
    expect(error.message).toContain("https://api.moonshot.cn/v1");
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain("Credentials rejected");
    expect(harness.storedSecrets.size).toBe(0);
    expect(harness.writes).toEqual([]);
  });

  it("replaces a key in place without losing disabled state, models or stable identity", async () => {
    const harness = apiKeyHarness();
    const account = {
      id: "zai-stable",
      provider: "zai",
      label: "Team",
      enabled: false,
      priority: 0,
      weight: 1,
      models: ["glm-test"],
      apiKeySecret: { scope: "workjet-provider-gateway", name: "existing-key" },
      credentialSuffix: "old1",
    };
    const document = {
      ...JSON.parse(configuration),
      accounts: [...JSON.parse(configuration).accounts, account],
    };
    harness.platform = { ...harness.platform, readText: async () => JSON.stringify(document) };
    const result = await runWithSecrets(harness, (gateway) =>
      gateway.addApiKeyAccount({
        accountId: WorkjetGatewayAccountId.make("zai-stable"),
        provider: "zai",
        label: "Team",
        apiKey: API_KEY,
      }),
    );
    expect(result.accountId).toBe("zai-stable");
    const stored = JSON.parse(harness.writes.find((entry) => entry.includes("apiKeySecret"))!);
    expect(
      stored.accounts.filter((entry: { provider: string }) => entry.provider === "zai"),
    ).toEqual([{ ...account, credentialSuffix: "abcd" }]);
    expect(harness.storedSecrets.get("workjet-provider-gateway.existing-key")).toBe(API_KEY);
    expect(harness.writes.join("\n")).not.toContain(API_KEY);
  });

  it("restores the previous key if persisting its new configuration fails", async () => {
    const harness = apiKeyHarness();
    const account = {
      id: "zai-stable",
      provider: "zai",
      label: "Team",
      models: ["glm-test"],
      apiKeySecret: { scope: "workjet-provider-gateway", name: "existing-key" },
    };
    harness.platform = {
      ...harness.platform,
      readText: async () =>
        JSON.stringify({
          ...JSON.parse(configuration),
          accounts: [...JSON.parse(configuration).accounts, account],
        }),
      writePrivateText: async () => {
        throw new Error("fixture write failed");
      },
    };
    const failure = await runWithSecrets(harness, (gateway) =>
      gateway
        .addApiKeyAccount({
          accountId: WorkjetGatewayAccountId.make("zai-stable"),
          provider: "zai",
          label: "Team",
          apiKey: API_KEY,
        })
        .pipe(Effect.flip),
    );
    expect(failure.reason).toBe("invalid-configuration");
    expect(harness.storedSecrets.get("workjet-provider-gateway.existing-key")).toBe(
      "provider-secret",
    );
    expect(harness.spawnCount()).toBe(0);
  });

  it("rejects replacement of another provider before touching any secret", async () => {
    const harness = apiKeyHarness();
    const failure = await runWithSecrets(harness, (gateway) =>
      gateway
        .addApiKeyAccount({
          accountId: WorkjetGatewayAccountId.make("codex-primary"),
          provider: "zai",
          label: "Team",
          apiKey: API_KEY,
        })
        .pipe(Effect.flip),
    );
    expect(failure.reason).toBe("invalid-configuration");
    expect(harness.storedSecrets.size).toBe(0);
    expect(harness.writes).toEqual([]);
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

  it("does not recover compiled suggestions when the live catalog is unavailable", async () => {
    const harness = poolHarness();
    const discovery = await runPools(harness, (gateway) => gateway.discoverModels());
    expect(
      discovery.providers.every(
        (provider) => !provider.catalogAvailable && provider.channel === null,
      ),
    ).toBe(true);
    expect(
      discovery.providers
        .flatMap((provider) => provider.models)
        .every((model) => model.source === "account-configuration"),
    ).toBe(true);
    expect(harness.routes.some((route) => route.includes("model-definitions/"))).toBe(false);
  });

  it("discovers actual Kimi IDs from the fresh public catalog without reading compiled definitions", async () => {
    const harness = readyHarness();
    const configuration = JSON.stringify({
      schemaVersion: 1,
      defaultProvider: "kimi",
      accounts: [
        {
          id: "kimi-observed",
          label: "Kimi",
          provider: "kimi",
          models: [],
          apiKeySecret: { scope: "workjet-provider-gateway", name: "kimi.key" },
        },
      ],
      pools: [],
      routes: [],
    });
    const platform: ProviderGatewayPlatform = {
      ...harness.platform,
      now: () => 1_000,
      readText: async () => configuration,
      publicModelCatalog: async () => ({
        schemaVersion: 1,
        checkedAt: "1970-01-01T00:00:01.000Z",
        expiresAt: "1970-01-01T00:01:01.000Z",
        providers: [{ provider: "kimi", status: "observed", models: ["k3", "kimi-for-coding"] }],
      }),
    };
    const discovery = await runGateway(platform, (gateway) =>
      Effect.gen(function* () {
        yield* gateway.start();
        return yield* gateway.discoverModels();
      }),
    );
    expect(discovery.providers).toEqual([
      {
        provider: "kimi",
        channel: null,
        catalogAvailable: true,
        models: ["k3", "kimi-for-coding"].map((id) => ({
          id,
          displayName: id,
          source: "gateway-catalog",
        })),
      },
    ]);
  });

  it("persists legacy strategy and membership edits while projecting the fixed host policy", async () => {
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
    expect(result.catalog.routingStrategy).toBe("fill-first");
    expect(claudePool?.strategy).toBe("fill-first");
    expect(claudePool?.weightHonored).toBe(false);
    expect(claudePool?.priorityExclusive).toBe(false);
    // Persist accepted legacy settings while keeping every enabled account
    // available to the fixed host policy and its runtime health checks.
    expect(claudePool?.members.map((member) => [member.accountId, member.selectable])).toEqual([
      ["claude-a", true],
      ["claude-b", true],
    ]);
    expect(harness.writes.findLast((entry) => entry.includes('"routing_strategy":'))).toContain(
      '"routing_strategy":"fill-first"',
    );
    expect(
      harness.writes.some((entry) => entry.includes('"routing_strategy":"weighted-round-robin"')),
    ).toBe(false);
  });

  it("edits display label and models while preserving the account and secret references", async () => {
    const harness = poolHarness();
    const before = JSON.parse(harness.configuration()).accounts.find(
      (entry: { id: string }) => entry.id === "claude-a",
    );
    const result = await runPools(harness, (gateway) =>
      gateway.updateRouting({
        strategy: "fill-first",
        accounts: [
          {
            accountId: WorkjetGatewayAccountId.make("claude-a"),
            enabled: true,
            priority: 0,
            weight: 1,
            label: "Renamed account",
            models: ["claude-test"],
          },
        ],
      }),
    );
    const after = JSON.parse(harness.configuration()).accounts.find(
      (entry: { id: string }) => entry.id === "claude-a",
    );
    expect(after).toEqual({
      ...before,
      label: "Renamed account",
      enabled: true,
      priority: 0,
      weight: 1,
      models: ["claude-test"],
    });
    expect(result.catalog.accounts.find((entry) => entry.id === "claude-a")?.label).toBe(
      "Renamed account",
    );
  });

  it("saves a display-name edit without restarting an in-flight host", async () => {
    const harness = readyHarness();
    await runGateway(harness.platform, (gateway) =>
      Effect.gen(function* () {
        yield* gateway.start();
        const result = yield* gateway.updateRouting({
          strategy: "fill-first",
          accounts: [
            {
              accountId: WorkjetGatewayAccountId.make("codex-primary"),
              enabled: true,
              priority: 0,
              weight: 1,
              label: "Renamed account",
            },
          ],
        });
        expect(result.catalog.accounts[0]?.label).toBe("Renamed account");
        expect(harness.spawnCount()).toBe(1);
        expect(harness.kills).toEqual([]);
      }),
    );
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

  it("allows disabling all default-provider accounts without losing them", async () => {
    const harness = poolHarness();
    const result = await runPools(harness, (gateway) =>
      gateway.updateRouting({
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
      }),
    );
    const document = JSON.parse(harness.configuration()) as {
      accounts: ReadonlyArray<{ id: string; enabled: boolean }>;
    };
    expect(document.accounts).toHaveLength(3);
    expect(
      document.accounts
        .filter((account) => account.id.startsWith("claude"))
        .every((account) => !account.enabled),
    ).toBe(true);
    expect(
      result.catalog.accounts
        .filter((account) => account.provider === "claude")
        .every((account) => !account.enabled),
    ).toBe(true);
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


describe("shared provider model commands", () => {
  const account = {
    id: "kimi-primary", label: "Primary", provider: "kimi", enabled: true,
    models: ["k3"], availableModelIds: ["k3", "kimi-for-coding"],
    apiKeySecret: { scope: "workjet-provider-gateway", name: "kimi-primary" },
    upstreamBaseUrl: "https://api.kimi.com/coding/v1", kimiPlan: "coding",
  };
  const harnessForSharedModels = () => {
    const harness = readyHarness();
    let stored = JSON.stringify({ schemaVersion: 1, defaultProvider: "kimi", accounts: [account, {
      ...account, id: "kimi-backup", label: "Backup", enabled: false,
    }], pools: [], routes: [] });
    return { harness, stored: () => stored, platform: {
      ...harness.platform, discoverKimiConnection: undefined,
      readText: async () => stored,
      writePrivateText: async (path: string, text: string) => {
        if (path.endsWith("provider-gateway.json")) stored = text;
        harness.writes.push(text);
      },
    } };
  };
  it("persists provider edits, account exclusions and unchanged credentials across reads", async () => {
    const fixture = harnessForSharedModels();
    await runGateway(fixture.platform, gateway => Effect.gen(function* () {
      const selected = yield* gateway.updateRouting({
        strategy: "fill-first", accounts: [],
        providers: [{ provider: "kimi", modelIds: ["k3", "kimi-for-coding"] }],
      });
      expect(selected.catalog.accounts.map(entry => entry.modelIds)).toEqual([["k3", "kimi-for-coding"], ["k3", "kimi-for-coding"]]);
      const excluded = yield* gateway.updateRouting({
        strategy: "fill-first", accounts: [{
          accountId: WorkjetGatewayAccountId.make("kimi-primary"), enabled: true,
          priority: 0, weight: 1, excludedModels: ["k3"],
        }],
      });
      expect(excluded.catalog.accounts[0]?.modelIds).toEqual(["kimi-for-coding"]);
      expect(excluded.catalog.accounts[1]?.enabled).toBe(false);
      expect(JSON.parse(fixture.stored()).accounts[0].apiKeySecret).toEqual(account.apiKeySecret);
      expect(JSON.stringify(excluded.catalog)).not.toContain("apiKeySecret");
      expect((yield* gateway.catalog()).accounts[0]?.excludedModelIds).toEqual(["k3"]);
    }));
  });
  it("refuses newly selected IDs not evidenced for this provider without writing configuration", async () => {
    const fixture = harnessForSharedModels();
    const before = fixture.stored();
    const result = await runGateway(fixture.platform, gateway => gateway.updateRouting({
      strategy: "fill-first", accounts: [],
      // Real Anthropic GET/models ID, deliberately submitted under the wrong provider.
      providers: [{ provider: "kimi", modelIds: ["claude-opus-5-5"] }],
    }).pipe(Effect.flip));
    expect(result.reason).toBe("invalid-configuration");
    expect(fixture.stored()).toBe(before);
  });
});
