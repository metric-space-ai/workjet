import { WorkjetGatewayAccountId, type WorkjetGatewayCatalog } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { miniMaxGatewayProfileConfiguration } from "./MiniMaxGatewayProfile.ts";

const model = "claude-opus-5-5";
const accountId = WorkjetGatewayAccountId.make("connected-claude");
const catalog = (enabled = true): WorkjetGatewayCatalog => ({
  schemaVersion: 1,
  accounts: [{ id: accountId, label: "Connected account", provider: "claude", enabled, priority: 0, weight: 1, modelIds: [model], credentialSuffix: null }],
  models: [{ id: model, displayName: model, providers: ["claude"], accountIds: [accountId] }],
  pools: [], routes: [], providerPools: [], routingStrategy: "round-robin",
});

describe("MiniMax gateway profile", () => {
  it("uses the pinned native custom-provider schema and a per-model upstream header", () => {
    const profile = miniMaxGatewayProfileConfiguration("http://127.0.0.1:53333/", catalog(), model);
    expect(profile.defaultModel).toBe(`custom_provider:workjet-gateway/${model}`);
    expect(profile.custom_provider["workjet-gateway"]).toEqual({
      name: "Workjet gateway", kind: "custom", enabled: true, api: "anthropic-messages",
      options: { baseURL: "http://127.0.0.1:53333", apiKey: "workjet-gateway", authMode: "api-key" },
      models: { [model]: { headers: { "X-CTOX-Provider": "claude" } } },
    });
  });
  it("rejects a model whose connected account was disabled", () => {
    expect(() => miniMaxGatewayProfileConfiguration("http://127.0.0.1:53333", catalog(false), model)).toThrow();
  });
  it("never fills an empty account catalog with a vendor default", () => {
    expect(() => miniMaxGatewayProfileConfiguration("http://127.0.0.1:53333", { ...catalog(), accounts: [], models: [] }, model)).toThrow();
  });
});
