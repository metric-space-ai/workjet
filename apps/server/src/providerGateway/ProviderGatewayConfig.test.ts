import { describe, expect, it } from "vite-plus/test";

import {
  decodeProviderGatewayConfiguration,
  gatewayCatalog,
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
});
