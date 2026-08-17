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
