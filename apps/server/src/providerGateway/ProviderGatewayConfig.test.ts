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
});
