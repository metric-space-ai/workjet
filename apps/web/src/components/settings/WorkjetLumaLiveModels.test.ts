import {
  WorkjetGatewayAccountId, WorkjetLlmRouteId,
  type WorkjetGatewayAccountSummary, type WorkjetGatewayAccountModels,
} from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { assertLumaLiveModelChoice, createWorkjetWorkerDraft, saveWorkjetWorkerDraft } from "./WorkjetWorkerEditor";

// Authenticated Anthropic GET /models, Models g3-claude-live-models-20261009.json.
const model = "claude-opus-5-5";
const account: WorkjetGatewayAccountSummary = {
  id: WorkjetGatewayAccountId.make("claude-account"),
  provider: "claude", label: "Claude account", enabled: true,
  priority: 0, weight: 1, modelIds: [model], credentialSuffix: null,
};
const catalog: WorkjetGatewayAccountModels = {
  accountId: account.id, checkedAtMs: 100, state: "observed", reason: null, modelIds: [model],
};
const draft = {
  ...createWorkjetWorkerDraft({ computers: [], routes: [], id: "luma" }),
  name: "Molecularity supervisor", computerId: "computer",
  llmRouteId: WorkjetLlmRouteId.make("claude-route"), modelId: model,
};

describe("Claude Luma live account choice", () => {
  it("accepts the exact selected account's observed and enabled model", () => {
    expect(() => assertLumaLiveModelChoice(draft, null, account, catalog)).not.toThrow();
  });
  it("rejects another account, unavailable discovery, disabled and excluded choices", () => {
    for (const candidate of [null,
      { ...catalog, accountId: WorkjetGatewayAccountId.make("another-account") },
      { ...catalog, state: "unavailable" as const, reason: "catalog-unavailable" as const },
      { ...catalog, modelIds: [] },
    ]) expect(() => assertLumaLiveModelChoice(draft, null, account, candidate)).toThrow();
    expect(() => assertLumaLiveModelChoice(draft, null, { ...account, enabled: false }, catalog)).toThrow("Enable");
    expect(() => assertLumaLiveModelChoice(draft, null, { ...account, modelIds: [] }, catalog)).toThrow("Settings → Models");
    expect(() => assertLumaLiveModelChoice(draft, null, { ...account, excludedModelIds: [model] }, catalog)).toThrow("Settings → Models");
  });
  it("preserves unchanged saved choices during an outage without authorizing a new route", () => {
    const prior = saveWorkjetWorkerDraft(draft);
    expect(() => assertLumaLiveModelChoice({ ...draft, name: "Renamed" }, prior, account, null)).not.toThrow();
    expect(() => assertLumaLiveModelChoice({ ...draft, llmRouteId: "new-route" }, prior, account, null)).toThrow("Refresh");
  });
});
