import { WorkjetGatewayAccountId, type WorkjetGatewayCatalog } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { openCodeGatewayConfiguration, openCodeGatewayModel } from "./OpenCodeGatewayProfile.ts";

// This account model was observed on the real gateway and completed twenty native Bash calls.
const model = "claude-opus-5-5";
const accountId = WorkjetGatewayAccountId.make("connected-claude");
const catalog: WorkjetGatewayCatalog = {
  schemaVersion: 1,
  accounts: [{ id: accountId, label: "Connected Claude", provider: "claude", enabled: true, priority: 0, weight: 1, modelIds: [model], credentialSuffix: null }],
  pools: [], routes: [], providerPools: [], routingStrategy: "fill-first",
  models: [{ id: model, displayName: model, providers: ["claude"], accountIds: [accountId] }],
};

describe("OpenCode gateway providers", () => {
  it("uses Responses with a catalog-resolved upstream header and native model ID", () => {
    const config = JSON.parse(openCodeGatewayConfiguration("http://127.0.0.1:9000/", catalog));
    expect(openCodeGatewayModel(catalog, model)).toBe(`workjet-gateway-claude/${model}`);
    expect(config.provider["workjet-gateway-claude"]).toEqual({
      npm: "@ai-sdk/openai", name: "Workjet (claude)",
      options: { baseURL: "http://127.0.0.1:9000/v1", apiKey: "workjet-gateway", headers: { "X-CTOX-Provider": "claude" } },
      models: { [model]: { name: model } },
    });
  });
  it("preserves runtime preferences and adds the gateway to an existing allowlist", () => {
    const config = JSON.parse(openCodeGatewayConfiguration("http://127.0.0.1:9000", catalog, JSON.stringify({ theme: "system", enabled_providers: ["anthropic"], provider: { anthropic: { options: { timeout: 10 } } } })));
    expect(config.theme).toBe("system");
    expect(config.provider.anthropic.options.timeout).toBe(10);
    expect(config.enabled_providers).toEqual(["anthropic", "workjet-gateway-claude"]);
  });
  it("does not fabricate providers or fall back to native credentials for unavailable models", () => {
    const disabled = { ...catalog, accounts: catalog.accounts.map(account => ({ ...account, enabled: false })) };
    expect(JSON.parse(openCodeGatewayConfiguration("http://127.0.0.1:9000", disabled)).provider).toEqual({});
    expect(() => openCodeGatewayModel(disabled, model)).toThrow();
    expect(() => openCodeGatewayConfiguration("http://127.0.0.1:9000", catalog, "[]")).toThrow();
  });
});
