import { describe, expect, it } from "vite-plus/test";
import {
  decodeProviderGatewayConfiguration,
  gatewayCatalog,
  rustHostConfiguration,
} from "./ProviderGatewayConfig.ts";
import {
  adoptProviderModelSelection,
  applyProviderModelSelection,
  projectProviderModelSelection,
  retainProviderModelSelection,
} from "./ProviderModelSelection.ts";

// Kimi Code real-account GET /models, 2026-10-08; no invented model identifiers.
const configuration = () =>
  decodeProviderGatewayConfiguration({
    schemaVersion: 1,
    defaultProvider: "kimi",
    accounts: [
      {
        id: "primary",
        label: "Primary",
        provider: "kimi",
        enabled: true,
        models: ["k3"],
        apiKeySecret: { scope: "workjet-provider-gateway", name: "primary" },
        availableModelIds: ["k3", "kimi-for-coding", "k3-256k"],
      },
      {
        id: "backup",
        label: "Backup",
        provider: "kimi",
        enabled: false,
        models: ["kimi-for-coding"],
        apiKeySecret: { scope: "workjet-provider-gateway", name: "backup" },
        availableModelIds: ["k3", "kimi-for-coding"],
      },
    ],
    pools: [],
    routes: [],
  })!;
describe("provider model selection", () => {
  it("adopts old account lists without expanding eligibility or changing credentials", () => {
    const before = configuration(),
      next = adoptProviderModelSelection(before);
    expect(next.providerModels).toEqual([
      { provider: "kimi", modelIds: ["k3", "kimi-for-coding"] },
    ]);
    expect(next.accounts.map((account) => account.models)).toEqual(
      before.accounts.map((account) => account.models),
    );
    expect(next.accounts[1]?.excludedModels).toEqual(["k3"]);
    expect(next.accounts[1]?.enabled).toBe(false);
    expect(JSON.stringify(rustHostConfiguration(next, "/private/secrets"))).toBe(
      JSON.stringify(rustHostConfiguration(before, "/private/secrets")),
    );
  });
  it("propagates selection through the live list and keeps account exclusions", () => {
    const next = applyProviderModelSelection(configuration(), [
      { provider: "kimi", modelIds: ["k3", "kimi-for-coding", "k3-256k"] },
    ]);
    expect(next.accounts.map((account) => account.models)).toEqual([
      ["k3", "k3-256k"],
      ["kimi-for-coding"],
    ]);
    const restored = projectProviderModelSelection({
      ...next,
      accounts: next.accounts.map((account) => ({ ...account, excludedModels: [] })),
    });
    expect(restored.accounts.map((account) => account.models)).toEqual([
      ["k3", "kimi-for-coding", "k3-256k"],
      ["k3", "kimi-for-coding"],
    ]);
  });
  it("persists exclusions through provider model removal and re-addition", () => {
    const adopted = adoptProviderModelSelection(configuration());
    const reopened = decodeProviderGatewayConfiguration(
      JSON.parse(
        JSON.stringify(applyProviderModelSelection(adopted, [{ provider: "kimi", modelIds: [] }])),
      ),
    )!;
    expect(
      applyProviderModelSelection(reopened, adopted.providerModels!).accounts.map(
        (account) => account.models,
      ),
    ).toEqual([["k3"], ["kimi-for-coding"]]);
  });
  it("does not infer unknown account access from a provider-wide live union", () => {
    const base = configuration(),
      accounts = base.accounts.map(({ availableModelIds: _unknown, ...account }) => account);
    const next = applyProviderModelSelection({ ...base, accounts }, [
      { provider: "kimi", modelIds: ["k3", "kimi-for-coding", "k3-256k"] },
    ]);
    expect(next.accounts.map((account) => account.models)).toEqual([["k3"], ["kimi-for-coding"]]);
  });
  it("lets new observed accounts inherit selection without another account's exclusions", () => {
    const base = adoptProviderModelSelection(configuration());
    const fresh = {
      ...base.accounts[0]!,
      id: "new",
      excludedModels: [],
      availableModelIds: ["k3", "kimi-for-coding"],
    };
    const next = retainProviderModelSelection(base, [...base.accounts, fresh]);
    expect(next.accounts[2]?.models).toEqual(["k3", "kimi-for-coding"]);
    expect(gatewayCatalog(next).providerModels).toEqual(base.providerModels);
    expect(JSON.stringify(gatewayCatalog(next))).not.toContain("apiKeySecret");
    expect(JSON.stringify(rustHostConfiguration(next, "/private/secrets"))).not.toContain(
      "excludedModels",
    );
  });
  it("rejects malformed selections and preserves empty shared lists", () => {
    const base = configuration();
    expect(
      decodeProviderGatewayConfiguration({
        ...base,
        providerModels: [{ provider: "kimi", modelIds: [] }],
      })?.providerModels,
    ).toEqual([{ provider: "kimi", modelIds: [] }]);
    expect(
      decodeProviderGatewayConfiguration({
        ...base,
        providerModels: [
          { provider: "kimi", modelIds: [] },
          { provider: "kimi", modelIds: [] },
        ],
      }),
    ).toBeUndefined();
    expect(
      decodeProviderGatewayConfiguration({
        ...base,
        accounts: [{ ...base.accounts[0], excludedModels: "k3" }],
      }),
    ).toBeUndefined();
  });
});
