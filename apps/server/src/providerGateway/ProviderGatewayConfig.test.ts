import { describe, expect, it } from "vite-plus/test";

import {
  decodeProviderGatewayConfiguration,
  gatewayCatalog,
  providerPools,
  rustHostConfiguration,
} from "./ProviderGatewayConfig.ts";

const secret = (name: string) => ({ scope: "workjet-provider-gateway", name }) as const;

const validConfiguration = () => ({
  schemaVersion: 1,
  defaultProvider: "codex",
  accounts: [
    {
      id: "codex-primary",
      label: "Primary Codex",
      provider: "codex",
      enabled: true,
      priority: 10,
      weight: 2,
      models: ["gpt-test"],
      idTokenSecret: secret("codex.id"),
      accessTokenSecret: secret("codex.access"),
      refreshTokenSecret: secret("codex.refresh"),
    },
  ],
  pools: [
    {
      id: "codex-pool",
      label: "Codex pool",
      provider: "codex",
      accountIds: ["codex-primary"],
      modelIds: ["gpt-test"],
    },
  ],
  routes: [
    {
      id: "default-route",
      label: "Default route",
      poolId: "codex-pool",
      provider: "codex",
      modelIds: ["gpt-test"],
    },
  ],
});

describe("ProviderGatewayConfig", () => {
  it("decodes a secret-reference-only catalog", () => {
    const decoded = decodeProviderGatewayConfiguration(validConfiguration());
    expect(decoded).toBeDefined();
    expect(gatewayCatalog(decoded!).accounts).toEqual([
      {
        id: "codex-primary",
        label: "Primary Codex",
        provider: "codex",
        enabled: true,
        priority: 10,
        weight: 2,
        modelIds: ["gpt-test"],
        credentialSuffix: null,
      },
    ]);
  });

  it("rejects plaintext credentials, foreign secret scopes, and harness provider instances", () => {
    for (const patch of [
      { accessToken: "plaintext-must-not-be-accepted" },
      { providerInstanceId: "codex-driver" },
      { accessTokenSecret: { scope: "provider-settings", name: "codex.access" } },
    ]) {
      const input = validConfiguration();
      Object.assign(input.accounts[0]!, patch);
      expect(decodeProviderGatewayConfiguration(input)).toBeUndefined();
    }
  });

  it("rejects duplicate authorities and cross-provider pool references", () => {
    const duplicate = validConfiguration();
    duplicate.accounts.push({ ...duplicate.accounts[0]! });
    expect(decodeProviderGatewayConfiguration(duplicate)).toBeUndefined();

    const crossed = validConfiguration();
    Object.assign(crossed.pools[0]!, { provider: "claude" });
    expect(decodeProviderGatewayConfiguration(crossed)).toBeUndefined();
  });

  it("renders only references into the host configuration", () => {
    const decoded = decodeProviderGatewayConfiguration(validConfiguration())!;
    const rendered = JSON.stringify(rustHostConfiguration(decoded, "/private/secrets"));
    expect(rendered).toContain("codex.access");
    expect(rendered).not.toContain("plaintext-must-not-be-accepted");
    expect(rendered).not.toContain("providerInstanceId");
  });

  describe("API-key accounts", () => {
    const apiKeyConfiguration = (patch: Record<string, unknown> = {}) => ({
      schemaVersion: 1,
      defaultProvider: "zai",
      accounts: [
        {
          id: "zai-primary",
          label: "Z.ai key",
          provider: "zai",
          enabled: true,
          priority: 0,
          weight: 1,
          models: [],
          apiKeySecret: secret("account-zai-primary-api-key"),
          credentialSuffix: "9xyz",
          ...patch,
        },
      ],
      pools: [],
      routes: [],
    });

    it("decodes every supported API-key provider and exposes only the masked suffix", () => {
      for (const provider of ["zai", "minimax", "xai", "kimi"]) {
        const decoded = decodeProviderGatewayConfiguration({
          ...apiKeyConfiguration({ provider }),
          defaultProvider: provider,
        });
        expect(decoded, provider).toBeDefined();
        const [account] = gatewayCatalog(decoded!).accounts;
        expect(account?.provider).toBe(provider);
        expect(account?.credentialSuffix).toBe("9xyz");
      }
    });

    it("refuses a literal key, an OAuth token reference, a plaintext suffix, and a non-https override", () => {
      for (const patch of [
        { apiKey: "sk-plaintext-must-not-be-accepted" },
        { accessTokenSecret: secret("zai.access") },
        { apiKeySecret: { scope: "provider-settings", name: "zai.key" } },
        { credentialSuffix: "far-too-long-to-be-a-suffix" },
        { upstreamBaseUrl: "http://api.z.ai/api/paas/v4" },
      ]) {
        expect(
          decodeProviderGatewayConfiguration(apiKeyConfiguration(patch)),
          JSON.stringify(patch),
        ).toBeUndefined();
      }
    });

    it("renders an api_key_accounts entry that carries a reference and no key", () => {
      const decoded = decodeProviderGatewayConfiguration(apiKeyConfiguration())!;
      const host = rustHostConfiguration(decoded, "/private/secrets") as {
        defaultProvider?: string;
        runtime: { api_key_accounts: ReadonlyArray<Record<string, unknown>> };
      };
      expect(host.defaultProvider).toBe("zai");
      expect(host.runtime.api_key_accounts).toEqual([
        {
          id: "zai-primary",
          provider: "zai",
          disabled: false,
          priority: 0,
          weight: 1,
          models: [],
          api_key_secret: secret("account-zai-primary-api-key"),
          // Empty: the Rust host owns the per-provider default endpoint.
          upstream_base_url: "",
        },
      ]);
      const rendered = JSON.stringify(host);
      expect(rendered).toContain("account-zai-primary-api-key");
      expect(rendered).not.toContain("sk-");
    });
  });

  describe("xAI subscription accounts", () => {
    // The provider string "xai" names TWO shapes; the credential fields tell
    // them apart. These tests pin that disambiguation.
    const xaiSubscription = (patch: Record<string, unknown> = {}) => ({
      schemaVersion: 1,
      defaultProvider: "xai",
      accounts: [
        {
          id: "xai-sub",
          label: "Grok subscription",
          provider: "xai",
          enabled: true,
          priority: 0,
          weight: 1,
          models: ["grok-4.6"],
          accessTokenSecret: secret("account-xai-sub-access-token"),
          refreshTokenSecret: secret("account-xai-sub-refresh-token"),
          ...patch,
        },
      ],
      pools: [],
      routes: [],
    });

    it("decodes by its token references and shows no credential suffix", () => {
      const decoded = decodeProviderGatewayConfiguration(xaiSubscription());
      expect(decoded).toBeDefined();
      const [account] = gatewayCatalog(decoded!).accounts;
      expect(account?.provider).toBe("xai");
      expect(account?.credentialSuffix).toBeNull();
    });

    it("refuses a hybrid record carrying both an API key and token references", () => {
      expect(
        decodeProviderGatewayConfiguration(
          xaiSubscription({ apiKeySecret: secret("account-xai-sub-api-key") }),
        ),
      ).toBeUndefined();
    });

    it("renders an xai_accounts entry without weight, beside empty api_key_accounts", () => {
      const decoded = decodeProviderGatewayConfiguration(xaiSubscription())!;
      const host = rustHostConfiguration(decoded, "/private/secrets") as {
        defaultProvider?: string;
        runtime: {
          xai_accounts: ReadonlyArray<Record<string, unknown>>;
          api_key_accounts: ReadonlyArray<Record<string, unknown>>;
        };
      };
      expect(host.defaultProvider).toBe("xai");
      expect(host.runtime.api_key_accounts).toEqual([]);
      // NO weight/websockets: the host struct denies unknown fields.
      expect(host.runtime.xai_accounts).toEqual([
        {
          id: "xai-sub",
          disabled: false,
          priority: 0,
          models: ["grok-4.6"],
          access_token_secret: secret("account-xai-sub-access-token"),
          refresh_token_secret: secret("account-xai-sub-refresh-token"),
          upstream_base_url: "",
          token_endpoint: "",
        },
      ]);
    });
  });

  describe("environment-scoped credentials", () => {
    /**
     * The gateway's credentials belong to the environment whose secret store
     * holds them. Two things keep them there, and both are asserted here
     * because "scoped" is otherwise an assumption: a reference may only name
     * the gateway's own scope, and its name may not walk out of the secret
     * directory. Together they mean the only file a gateway configuration can
     * ever resolve is `<this environment's secretsDir>/workjet-provider-gateway.<name>.bin`.
     */
    it("refuses a reference to another scope or outside the secret directory", () => {
      for (const name of [
        "..",
        ".",
        "../../other-environment/secrets/claude.access",
        "..%2fescape",
        "sub/dir",
        "back\\slash",
        "space here",
      ]) {
        const input = validConfiguration();
        Object.assign(input.accounts[0]!, { accessTokenSecret: secret(name) });
        expect(decodeProviderGatewayConfiguration(input), name).toBeUndefined();
      }
      for (const scope of ["provider-settings", "workjet-provider-gateway ", "", "../"]) {
        const input = validConfiguration();
        Object.assign(input.accounts[0]!, {
          accessTokenSecret: { scope, name: "codex.access" },
        });
        expect(decodeProviderGatewayConfiguration(input), scope).toBeUndefined();
      }
    });

    it("renders each environment's own secret root and never another environment's", () => {
      const decoded = decodeProviderGatewayConfiguration(validConfiguration())!;
      const first = rustHostConfiguration(decoded, "/environments/alpha/secrets") as {
        secretRoot: string;
      };
      const second = rustHostConfiguration(decoded, "/environments/beta/secrets") as {
        secretRoot: string;
      };
      expect(first.secretRoot).toBe("/environments/alpha/secrets");
      expect(second.secretRoot).toBe("/environments/beta/secrets");
      expect(JSON.stringify(first)).not.toContain("/environments/beta/");
      expect(JSON.stringify(second)).not.toContain("/environments/alpha/");
    });
  });

  describe("pools", () => {
    const poolConfiguration = (
      accounts: ReadonlyArray<{
        readonly id: string;
        readonly provider: string;
        readonly enabled?: boolean;
        readonly priority?: number;
        readonly weight?: number;
      }>,
      routingStrategy?: string,
    ) => ({
      schemaVersion: 1,
      defaultProvider: accounts[0]?.provider ?? "claude",
      accounts: accounts.map((account) => ({
        id: account.id,
        label: account.id,
        provider: account.provider,
        enabled: account.enabled ?? true,
        priority: account.priority ?? 0,
        weight: account.weight ?? 1,
        models: [],
        ...(account.provider === "zai"
          ? { apiKeySecret: secret(`${account.id}-api-key`) }
          : {
              accessTokenSecret: secret(`${account.id}.access`),
              refreshTokenSecret: secret(`${account.id}.refresh`),
            }),
      })),
      pools: [],
      routes: [],
      ...(routingStrategy === undefined ? {} : { routingStrategy }),
    });

    it("defaults to the host's own strategy and refuses one the host does not implement", () => {
      const decoded = decodeProviderGatewayConfiguration(
        poolConfiguration([{ id: "claude-a", provider: "claude" }]),
      )!;
      expect(decoded.routingStrategy).toBe("round-robin");
      expect(
        decodeProviderGatewayConfiguration(
          poolConfiguration([{ id: "claude-a", provider: "claude" }], "least-loaded"),
        ),
      ).toBeUndefined();
    });

    it("passes the configured strategy through to the host runtime", () => {
      const decoded = decodeProviderGatewayConfiguration(
        poolConfiguration([{ id: "claude-a", provider: "claude" }], "weighted-round-robin"),
      )!;
      const host = rustHostConfiguration(decoded, "/secrets") as {
        runtime: { routing_strategy: string };
      };
      expect(host.runtime.routing_strategy).toBe("weighted-round-robin");
    });

    it("holds back lower-priority OAuth members, because the host's scheduler does", () => {
      const decoded = decodeProviderGatewayConfiguration(
        poolConfiguration([
          { id: "claude-a", provider: "claude", priority: 7 },
          { id: "claude-b", provider: "claude", priority: 0 },
          { id: "claude-c", provider: "claude", priority: 7, enabled: false },
        ]),
      )!;
      const [pool] = providerPools(decoded);
      expect(pool?.provider).toBe("claude");
      expect(pool?.priorityExclusive).toBe(true);
      expect(pool?.members.map((member) => [member.accountId, member.selectable])).toEqual([
        ["claude-a", true],
        ["claude-b", false],
        ["claude-c", false],
      ]);
    });

    it("honours weight only under the weighted strategy and never for an API-key pool", () => {
      const roundRobin = decodeProviderGatewayConfiguration(
        poolConfiguration([{ id: "claude-a", provider: "claude" }]),
      )!;
      expect(providerPools(roundRobin)[0]?.weightHonored).toBe(false);

      const weighted = decodeProviderGatewayConfiguration(
        poolConfiguration([{ id: "claude-a", provider: "claude" }], "weighted-round-robin"),
      )!;
      expect(providerPools(weighted)[0]?.weightHonored).toBe(true);

      // `ApiKeyAccountPool` reads neither the strategy nor the weight, and it
      // keeps lower-priority accounts in the rotation.
      const apiKey = decodeProviderGatewayConfiguration(
        poolConfiguration(
          [
            { id: "zai-a", provider: "zai", priority: 5 },
            { id: "zai-b", provider: "zai", priority: 0 },
          ],
          "weighted-round-robin",
        ),
      )!;
      const [pool] = providerPools(apiKey);
      expect(pool?.weightHonored).toBe(false);
      expect(pool?.priorityExclusive).toBe(false);
      expect(pool?.members.every((member) => member.selectable)).toBe(true);
    });

    it("puts the derived pools and the strategy on the catalog", () => {
      const decoded = decodeProviderGatewayConfiguration(
        poolConfiguration(
          [
            { id: "claude-a", provider: "claude" },
            { id: "zai-a", provider: "zai" },
          ],
          "fill-first",
        ),
      )!;
      const catalog = gatewayCatalog(decoded);
      expect(catalog.routingStrategy).toBe("fill-first");
      expect(catalog.providerPools.map((pool) => pool.provider)).toEqual(["claude", "zai"]);
      expect(catalog.providerPools.every((pool) => pool.strategy === "fill-first")).toBe(true);
    });
  });
});
