import { describe, expect, it } from "@effect/vitest";
import {
  WorkjetGatewayAccountId,
  WorkjetGatewayPoolId,
  WorkjetGatewayRouteId,
  type ProviderInstanceEnvironment,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  applyGatewayRoutingOverlay,
  codexGatewayLaunchArgs,
  driverCarriesGatewayProvider,
  gatewayRoutingEnvironmentOverlay,
  GATEWAY_CLAUDE_CUSTOM_HEADERS_ENV,
  GATEWAY_CODEX_API_KEY_ENV,
  GATEWAY_CODEX_LAUNCH_ARGS_ENV,
  GATEWAY_GROK_API_KEY_ENV,
  GATEWAY_GROK_BASE_URL_ENV,
  GATEWAY_PLACEHOLDER_API_KEY,
  gatewayVersionedBaseUrl,
  isGatewayRoutableDriver,
  normalizeGatewayBaseUrl,
  openCodeGatewayRoutingBlock,
  resolveGatewayRoutedEnvironment,
} from "./ProviderGatewayRouting.ts";
import {
  providerGatewayTestLayer,
  readyGatewayStatus,
  stoppedGatewayStatus,
  stoppedProviderGatewayTestLayer,
} from "./testUtils/providerGatewayTestLayer.ts";

const ENDPOINT = "http://127.0.0.1:52100";

const declared = (
  ...variables: ReadonlyArray<{ name: string; value: string }>
): ProviderInstanceEnvironment => variables.map((variable) => ({ ...variable, sensitive: false }));

const readyLayer = providerGatewayTestLayer(readyGatewayStatus(ENDPOINT));

const gatewayCatalog = (
  accounts: ReadonlyArray<{
    readonly id: string;
    readonly provider: WorkjetGatewayProvider;
    readonly modelIds: ReadonlyArray<string>;
  }>,
  routes: ReadonlyArray<{
    readonly id: string;
    readonly poolId: string;
    readonly provider: WorkjetGatewayProvider;
    readonly modelIds: ReadonlyArray<string>;
  }> = [],
): WorkjetGatewayCatalog => ({
  schemaVersion: 1,
  accounts: accounts.map((entry) => ({
    id: WorkjetGatewayAccountId.make(entry.id),
    label: entry.id,
    provider: entry.provider,
    enabled: true,
    priority: 0,
    weight: 1,
    modelIds: entry.modelIds,
    credentialSuffix: null,
  })),
  pools: [],
  routes: routes.map((entry) => ({
    id: WorkjetGatewayRouteId.make(entry.id),
    label: entry.id,
    poolId: WorkjetGatewayPoolId.make(entry.poolId),
    provider: entry.provider,
    modelIds: entry.modelIds,
  })),
  models: [],
  routingStrategy: "round-robin",
  providerPools: [],
});

const CATALOG = gatewayCatalog([
  { id: "claude_1", provider: "claude", modelIds: ["claude-opus-4"] },
  { id: "codex_1", provider: "codex", modelIds: ["gpt-5.4"] },
]);

const readyLayerWithCatalog = (catalog: WorkjetGatewayCatalog = CATALOG) =>
  providerGatewayTestLayer(readyGatewayStatus(ENDPOINT), catalog);

describe("gateway routing env mapping", () => {
  it("maps the Claude harness to base URL + placeholder key, never an auth token", () => {
    const overlay = gatewayRoutingEnvironmentOverlay({
      driver: "claudeAgent",
      providerEndpoint: ENDPOINT,
    });

    expect(overlay["ANTHROPIC_BASE_URL"]).toBe(ENDPOINT);
    expect(overlay["ANTHROPIC_API_KEY"]).toBe(GATEWAY_PLACEHOLDER_API_KEY);
    // Setting ANTHROPIC_AUTH_TOKEN alongside the API key makes which
    // credential the CLI sends version-dependent, so we must never set it.
    expect(overlay).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("strips a trailing slash from the advertised endpoint", () => {
    expect(normalizeGatewayBaseUrl("http://127.0.0.1:52100/")).toBe(ENDPOINT);
    expect(
      gatewayRoutingEnvironmentOverlay({
        driver: "claudeAgent",
        providerEndpoint: "http://127.0.0.1:52100///",
      })["ANTHROPIC_BASE_URL"],
    ).toBe(ENDPOINT);
  });

  // Verified against codex-cli 0.144.1: OPENAI_BASE_URL is ignored (the CLI
  // still reached api.openai.com), while these dotted `-c` overrides made it
  // POST to the local probe at <base_url>/responses. The overrides are
  // unquoted because Codex parses each value as TOML and falls back to the
  // raw string, and because the driver tokenizes this variable on whitespace.
  it("configures Codex through model_providers overrides, not a base-URL env var", () => {
    const overlay = gatewayRoutingEnvironmentOverlay({
      driver: "codex",
      providerEndpoint: ENDPOINT,
    });

    expect(overlay).not.toHaveProperty("OPENAI_BASE_URL");
    expect(overlay[GATEWAY_CODEX_API_KEY_ENV]).toBe(GATEWAY_PLACEHOLDER_API_KEY);

    const args = overlay[GATEWAY_CODEX_LAUNCH_ARGS_ENV] ?? "";
    expect(args).toContain("-c model_provider=workjet_gateway");
    expect(args).toContain(
      `-c model_providers.workjet_gateway.base_url=${gatewayVersionedBaseUrl(ENDPOINT)}`,
    );
    expect(args).toContain("-c model_providers.workjet_gateway.wire_api=responses");
    expect(args).toContain(
      `-c model_providers.workjet_gateway.env_key=${GATEWAY_CODEX_API_KEY_ENV}`,
    );
    expect(args).not.toContain('"');
  });

  it("appends gateway overrides to the operator's configured Codex launch args", () => {
    const overlay = gatewayRoutingEnvironmentOverlay({
      driver: "codex",
      providerEndpoint: ENDPOINT,
      existingLaunchArgs: "  --strict-config  ",
    });

    const args = overlay[GATEWAY_CODEX_LAUNCH_ARGS_ENV] ?? "";
    // The env var shadows the configured value entirely, so dropping the
    // operator's arguments here would be a silent regression.
    expect(args.startsWith("--strict-config ")).toBe(true);
    expect(args).toContain(codexGatewayLaunchArgs(ENDPOINT));
  });

  // Verified against the installed grok CLI: with GROK_MODELS_BASE_URL
  // pointed at a local probe the CLI fetched GET <base>/models and posted
  // turns to <base>/responses and <base>/chat/completions — all three are
  // routes the gateway serves.
  it("maps the Grok harness to its models base URL, /v1-prefixed", () => {
    const overlay = gatewayRoutingEnvironmentOverlay({
      driver: "grok",
      providerEndpoint: ENDPOINT,
    });

    // Grok joins bare route names onto the base URL, so the `/v1` prefix has
    // to be part of the value — unlike Claude Code's bare root.
    expect(overlay[GATEWAY_GROK_BASE_URL_ENV]).toBe(`${ENDPOINT}/v1`);
    expect(overlay[GATEWAY_GROK_API_KEY_ENV]).toBe(GATEWAY_PLACEHOLDER_API_KEY);
    // Grok derives the model list as `{base}/models`; pinning the list URL
    // separately would only be a second place to get the endpoint wrong.
    expect(overlay).not.toHaveProperty("GROK_MODELS_LIST_URL");
  });

  // Verified against the installed opencode CLI: `opencode run` against a
  // local probe reached POST <base>/messages for an anthropic/* model and
  // POST <base>/responses for an openai/* model, authenticating with the
  // placeholder key in each case.
  it("maps the OpenCode harness to both AI-SDK vendor base URLs", () => {
    const overlay = gatewayRoutingEnvironmentOverlay({
      driver: "opencode",
      providerEndpoint: ENDPOINT,
    });

    expect(overlay["ANTHROPIC_BASE_URL"]).toBe(`${ENDPOINT}/v1`);
    expect(overlay["ANTHROPIC_API_KEY"]).toBe(GATEWAY_PLACEHOLDER_API_KEY);
    expect(overlay["OPENAI_BASE_URL"]).toBe(`${ENDPOINT}/v1`);
    expect(overlay["OPENAI_API_KEY"]).toBe(GATEWAY_PLACEHOLDER_API_KEY);
  });

  it("derives every versioned base URL from one endpoint helper", () => {
    // One statement of the gateway's route layout; a driver that re-spelled
    // `${endpoint}/v1` by hand would drift the day the layout changes.
    const versioned = gatewayVersionedBaseUrl("http://127.0.0.1:52100///");
    expect(versioned).toBe(`${ENDPOINT}/v1`);

    for (const driver of ["grok", "opencode"] as const) {
      const overlay = gatewayRoutingEnvironmentOverlay({
        driver,
        providerEndpoint: "http://127.0.0.1:52100///",
      });
      expect(Object.values(overlay)).toContain(versioned);
    }
    expect(codexGatewayLaunchArgs("http://127.0.0.1:52100///")).toContain(`base_url=${versioned}`);
  });

  it("treats only the drivers with a verified mechanism as routable", () => {
    expect(isGatewayRoutableDriver("claudeAgent")).toBe(true);
    expect(isGatewayRoutableDriver("codex")).toBe(true);
    expect(isGatewayRoutableDriver("grok")).toBe(true);
    expect(isGatewayRoutableDriver("opencode")).toBe(true);
    // No verified base-URL mechanism — routed with guessed variables this
    // would silently keep billing the direct provider account.
    expect(isGatewayRoutableDriver("cursor")).toBe(false);
  });
});

describe("openCodeGatewayRoutingBlock", () => {
  it("blocks an opted-in instance that targets an external OpenCode server", () => {
    const blocked = openCodeGatewayRoutingBlock({
      instanceId: "opencode_main",
      routeViaGateway: true,
      serverUrl: " http://opencode.internal:4096 ",
    });

    // Workjet never spawns that process, so the overlay would be written and
    // silently ignored while the external server billed its own credentials.
    expect(blocked?.reason).toBe("instance-unroutable");
    expect(blocked?.detail).toContain("http://opencode.internal:4096");
  });

  it("does not block a self-hosted instance or an instance that did not opt in", () => {
    expect(
      openCodeGatewayRoutingBlock({
        instanceId: "opencode_main",
        routeViaGateway: true,
        serverUrl: "   ",
      }),
    ).toBeNull();
    expect(
      openCodeGatewayRoutingBlock({
        instanceId: "opencode_main",
        routeViaGateway: true,
        serverUrl: null,
      }),
    ).toBeNull();
    expect(
      openCodeGatewayRoutingBlock({
        instanceId: "opencode_main",
        routeViaGateway: false,
        serverUrl: "http://opencode.internal:4096",
      }),
    ).toBeNull();
  });
});

describe("gateway routing overlay precedence", () => {
  it("leaves an explicitly declared instance variable untouched", () => {
    const environment = declared({ name: "ANTHROPIC_BASE_URL", value: "http://pinned.local" });
    const merged = applyGatewayRoutingOverlay({
      merged: { ANTHROPIC_BASE_URL: "http://pinned.local" },
      declared: environment,
      overlay: gatewayRoutingEnvironmentOverlay({
        driver: "claudeAgent",
        providerEndpoint: ENDPOINT,
      }),
    });

    expect(merged["ANTHROPIC_BASE_URL"]).toBe("http://pinned.local");
    // Undeclared members of the overlay still land.
    expect(merged["ANTHROPIC_API_KEY"]).toBe(GATEWAY_PLACEHOLDER_API_KEY);
  });
});

describe("resolveGatewayRoutedEnvironment", () => {
  it.effect("injects gateway variables for an opted-in instance", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveGatewayRoutedEnvironment({
        driver: "claudeAgent",
        instanceId: "claude_main",
        routeViaGateway: true,
        environment: declared({ name: "FOO", value: "bar" }),
        baseEnv: { PATH: "/usr/bin" },
      });

      expect(resolved["ANTHROPIC_BASE_URL"]).toBe(ENDPOINT);
      expect(resolved["ANTHROPIC_API_KEY"]).toBe(GATEWAY_PLACEHOLDER_API_KEY);
      expect(resolved["FOO"]).toBe("bar");
      expect(resolved["PATH"]).toBe("/usr/bin");
    }).pipe(Effect.provide(readyLayer)),
  );

  it.effect("lets an explicitly declared instance variable win over the injection", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveGatewayRoutedEnvironment({
        driver: "claudeAgent",
        instanceId: "claude_main",
        routeViaGateway: true,
        environment: declared({ name: "ANTHROPIC_API_KEY", value: "operator-key" }),
        baseEnv: {},
      });

      expect(resolved["ANTHROPIC_API_KEY"]).toBe("operator-key");
      expect(resolved["ANTHROPIC_BASE_URL"]).toBe(ENDPOINT);
    }).pipe(Effect.provide(readyLayer)),
  );

  it.effect("leaves a non-opted instance completely untouched", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveGatewayRoutedEnvironment({
        driver: "claudeAgent",
        instanceId: "claude_main",
        routeViaGateway: false,
        environment: declared({ name: "FOO", value: "bar" }),
        baseEnv: { PATH: "/usr/bin" },
      });

      expect(resolved).toStrictEqual({ PATH: "/usr/bin", FOO: "bar" });
    }).pipe(
      // Even with a ready gateway, an instance that did not opt in must not
      // acquire routing variables.
      Effect.provide(readyLayer),
    ),
  );

  it.effect("fails instead of falling back when the gateway is not ready", () =>
    Effect.gen(function* () {
      const failure = yield* resolveGatewayRoutedEnvironment({
        driver: "claudeAgent",
        instanceId: "claude_main",
        routeViaGateway: true,
        environment: [],
        baseEnv: { ANTHROPIC_API_KEY: "direct-account-key" },
      }).pipe(Effect.flip);

      expect(failure._tag).toBe("ProviderGatewayRoutingError");
      expect(failure.reason).toBe("gateway-not-ready");
      expect(failure.instanceId).toBe("claude_main");
      expect(failure.message).toContain(stoppedGatewayStatus.phase);
    }).pipe(Effect.provide(stoppedProviderGatewayTestLayer)),
  );

  it.effect("fails when a ready gateway advertises no provider endpoint", () =>
    Effect.gen(function* () {
      const failure = yield* resolveGatewayRoutedEnvironment({
        driver: "codex",
        instanceId: "codex_main",
        routeViaGateway: true,
        environment: [],
        baseEnv: {},
      }).pipe(Effect.flip);

      expect(failure.reason).toBe("endpoint-unavailable");
    }).pipe(
      Effect.provide(
        providerGatewayTestLayer({ ...readyGatewayStatus(ENDPOINT), providerEndpoint: null }),
      ),
    ),
  );

  it.effect("injects Grok's base URL for an opted-in instance and nothing otherwise", () =>
    Effect.gen(function* () {
      const routed = yield* resolveGatewayRoutedEnvironment({
        driver: "grok",
        instanceId: "grok_main",
        routeViaGateway: true,
        environment: [],
        baseEnv: { PATH: "/usr/bin" },
      });
      expect(routed[GATEWAY_GROK_BASE_URL_ENV]).toBe(`${ENDPOINT}/v1`);
      expect(routed[GATEWAY_GROK_API_KEY_ENV]).toBe(GATEWAY_PLACEHOLDER_API_KEY);

      const unrouted = yield* resolveGatewayRoutedEnvironment({
        driver: "grok",
        instanceId: "grok_main",
        routeViaGateway: false,
        environment: [],
        baseEnv: { PATH: "/usr/bin", XAI_API_KEY: "direct-account-key" },
      });
      expect(unrouted).toStrictEqual({ PATH: "/usr/bin", XAI_API_KEY: "direct-account-key" });
    }).pipe(Effect.provide(readyLayer)),
  );

  it.effect(
    "injects OpenCode's vendor base URLs for an opted-in instance and nothing otherwise",
    () =>
      Effect.gen(function* () {
        const routed = yield* resolveGatewayRoutedEnvironment({
          driver: "opencode",
          instanceId: "opencode_main",
          routeViaGateway: true,
          environment: declared({ name: "OPENAI_API_KEY", value: "operator-key" }),
          baseEnv: { PATH: "/usr/bin" },
        });
        expect(routed["ANTHROPIC_BASE_URL"]).toBe(`${ENDPOINT}/v1`);
        expect(routed["OPENAI_BASE_URL"]).toBe(`${ENDPOINT}/v1`);
        // A key the operator declared on the instance still wins.
        expect(routed["OPENAI_API_KEY"]).toBe("operator-key");
        expect(routed["ANTHROPIC_API_KEY"]).toBe(GATEWAY_PLACEHOLDER_API_KEY);

        const unrouted = yield* resolveGatewayRoutedEnvironment({
          driver: "opencode",
          instanceId: "opencode_main",
          routeViaGateway: false,
          environment: [],
          baseEnv: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
        });
        expect(unrouted).toStrictEqual({
          PATH: "/usr/bin",
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        });
      }).pipe(Effect.provide(readyLayer)),
  );

  it.effect("carries the model's resolved provider as a Claude request header", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveGatewayRoutedEnvironment({
        driver: "claudeAgent",
        instanceId: "claude_main",
        routeViaGateway: true,
        environment: [],
        model: "claude-opus-4",
        baseEnv: {},
      });

      // Verified against Claude Code 2.1.226 with a loopback probe: this
      // variable puts `x-ctox-provider` on POST /v1/messages, which is the
      // gateway host's only per-request upstream selector.
      expect(resolved[GATEWAY_CLAUDE_CUSTOM_HEADERS_ENV]).toBe("X-CTOX-Provider: claude");
    }).pipe(Effect.provide(readyLayerWithCatalog())),
  );

  it.effect("carries the resolved provider as a Codex http_headers override", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveGatewayRoutedEnvironment({
        driver: "codex",
        instanceId: "codex_main",
        routeViaGateway: true,
        environment: [],
        model: "gpt-5.4",
        baseEnv: {},
      });

      expect(resolved[GATEWAY_CODEX_LAUNCH_ARGS_ENV]).toContain(
        "-c model_providers.workjet_gateway.http_headers.X-CTOX-Provider=codex",
      );
    }).pipe(Effect.provide(readyLayerWithCatalog())),
  );

  it.effect("lets an explicit route override which provider the model resolves to", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveGatewayRoutedEnvironment({
        driver: "claudeAgent",
        instanceId: "claude_main",
        routeViaGateway: true,
        environment: [],
        model: "claude-opus-4",
        baseEnv: {},
      });

      expect(resolved[GATEWAY_CLAUDE_CUSTOM_HEADERS_ENV]).toBe("X-CTOX-Provider: antigravity");
    }).pipe(
      Effect.provide(
        readyLayerWithCatalog(
          gatewayCatalog(
            [
              { id: "claude_1", provider: "claude", modelIds: ["claude-opus-4"] },
              { id: "ag_1", provider: "antigravity", modelIds: [] },
            ],
            [{ id: "opus", poolId: "ag_pool", provider: "antigravity", modelIds: ["claude-*"] }],
          ),
        ),
      ),
    ),
  );

  it.effect("fails typed for a model the gateway does not serve", () =>
    Effect.gen(function* () {
      const failure = yield* resolveGatewayRoutedEnvironment({
        driver: "claudeAgent",
        instanceId: "claude_main",
        routeViaGateway: true,
        environment: [],
        model: "made-up-model",
        baseEnv: {},
      }).pipe(Effect.flip);

      expect(failure.reason).toBe("model-unrouted");
      expect(failure.detail).toContain("made-up-model");
    }).pipe(Effect.provide(readyLayerWithCatalog())),
  );

  it.effect("fails typed when two providers both serve the model", () =>
    Effect.gen(function* () {
      const failure = yield* resolveGatewayRoutedEnvironment({
        driver: "codex",
        instanceId: "codex_main",
        routeViaGateway: true,
        environment: [],
        model: "shared-model",
        baseEnv: {},
      }).pipe(Effect.flip);

      expect(failure.reason).toBe("model-ambiguous");
    }).pipe(
      Effect.provide(
        readyLayerWithCatalog(
          gatewayCatalog([
            { id: "kimi_1", provider: "kimi", modelIds: ["shared-model"] },
            { id: "zai_1", provider: "zai", modelIds: ["shared-model"] },
          ]),
        ),
      ),
    ),
  );

  it.effect("reads no catalog at all when the session pinned no model", () =>
    Effect.gen(function* () {
      // The default test layer's `catalog()` FAILS, so this only passes while
      // an unpinned session skips the lookup entirely.
      const resolved = yield* resolveGatewayRoutedEnvironment({
        driver: "claudeAgent",
        instanceId: "claude_main",
        routeViaGateway: true,
        environment: [],
        baseEnv: {},
      });

      expect(resolved[GATEWAY_CLAUDE_CUSTOM_HEADERS_ENV]).toBeUndefined();
    }).pipe(Effect.provide(readyLayer)),
  );

  it.effect("reads no catalog for a driver that cannot carry the header", () =>
    Effect.gen(function* () {
      // Grok and OpenCode have no verified header env var. Resolving anyway
      // would turn an unroutable model into a session failure for a session
      // whose request could never have carried the answer.
      for (const driver of ["grok", "opencode"] as const) {
        const resolved = yield* resolveGatewayRoutedEnvironment({
          driver,
          instanceId: `${driver}_main`,
          routeViaGateway: true,
          environment: [],
          model: "made-up-model",
          baseEnv: {},
        });
        expect(resolved[GATEWAY_CLAUDE_CUSTOM_HEADERS_ENV]).toBeUndefined();
      }
      expect(driverCarriesGatewayProvider("grok")).toBe(false);
      expect(driverCarriesGatewayProvider("opencode")).toBe(false);
      expect(driverCarriesGatewayProvider("claudeAgent")).toBe(true);
      expect(driverCarriesGatewayProvider("codex")).toBe(true);
    }).pipe(Effect.provide(readyLayer)),
  );

  it.effect("fails typed when the catalog cannot be read", () =>
    Effect.gen(function* () {
      const failure = yield* resolveGatewayRoutedEnvironment({
        driver: "claudeAgent",
        instanceId: "claude_main",
        routeViaGateway: true,
        environment: [],
        model: "claude-opus-4",
        baseEnv: {},
      }).pipe(Effect.flip);

      expect(failure.reason).toBe("catalog-unavailable");
    }).pipe(Effect.provide(readyLayer)),
  );

  it.effect("fails for a driver with no verified routing mechanism", () =>
    Effect.gen(function* () {
      const failure = yield* resolveGatewayRoutedEnvironment({
        driver: "cursor",
        instanceId: "cursor_main",
        routeViaGateway: true,
        environment: [],
        baseEnv: {},
      }).pipe(Effect.flip);

      expect(failure.reason).toBe("driver-unsupported");
    }).pipe(Effect.provide(readyLayer)),
  );
});
