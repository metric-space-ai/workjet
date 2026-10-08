import { WorkjetGatewayAccountId, type WorkjetGatewayAccountSummary } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  WorkjetModelsProviders,
  type ModelsManagementState,
  type ModelsModelCheck,
} from "./WorkjetModelsProviders";
import type { WorkjetGatewaySectionState } from "./WorkjetGatewayAccounts";
import { modelCheckDescription } from "./WorkjetModelsCell";
import { parseModels } from "./WorkjetModelsFields";

const first: WorkjetGatewayAccountSummary = {
  id: WorkjetGatewayAccountId.make("account-a"),
  provider: "xai",
  label: "work@example.test",
  enabled: true,
  priority: 0,
  weight: 1,
  modelIds: ["grok-4.7"],
  credentialSuffix: null,
};
const second: WorkjetGatewayAccountSummary = {
  ...first,
  id: WorkjetGatewayAccountId.make("account-b"),
  label: "backup@example.test",
  modelIds: ["grok-4.6-exact"],
};
const check: ModelsModelCheck = {
  accountId: first.id,
  modelId: first.modelIds[0]!,
  status: "ok",
  errorClass: null,
  source: "upstream",
  httpStatus: 200,
  checkedAtMs: Date.parse("2026-10-07T10:00:00Z"),
  latencyMs: 354,
};
const state: WorkjetGatewaySectionState & ModelsManagementState = {
  status: {
    schemaVersion: 1,
    phase: "ready",
    pid: 1,
    providerEndpoint: "http://127.0.0.1:8317",
    managementEndpoint: "http://127.0.0.1:8318",
    failureReason: null,
    configuredAccountCount: 2,
    configuredModelCount: 2,
  },
  catalog: {
    schemaVersion: 1,
    accounts: [first, second],
    pools: [],
    routes: [],
    models: [],
    routingStrategy: "fill-first",
    providerPools: [],
  },
  isInitialLoading: false,
  isRefreshing: false,
  statusError: null,
  catalogError: null,
  isOperating: false,
  login: { status: "idle" },
  apiKey: { status: "idle" },
  mutationBusy: false,
  loginAccountId: null,
  accountErrors: {},
  accountHealth: {},
  modelChecks: [check],
  checksBusy: false,
  onRefresh: () => {},
  onRetry: () => {},
  onAddAccount: () => {},
  onCancelLogin: () => {},
  onAddApiKey: () => {},
  onRemoveAccount: () => {},
  onCheckModels: () => {},
  onEditAccount: async () => true,
  onEditModels: async () => true,
  onDeleteAccount: async () => true,
  onRelogin: () => {},
  onSaveApiKey: async () => true,
};

function html(overrides: Partial<typeof state> = {}) {
  return renderToStaticMarkup(<WorkjetModelsProviders {...state} {...overrides} />);
}
describe("Provider account table", () => {
  it("shows stacked accounts with their own editable models and only their own check result", () => {
    const rendered = html();
    expect(rendered).toContain('role="table"');
    expect(rendered).toContain("Provider / account");
    expect(rendered).toContain('value="work@example.test"');
    expect(rendered).toContain('value="backup@example.test"');
    expect(rendered).toContain('value="grok-4.7"');
    expect(rendered).toContain('value="grok-4.6-exact"');
    expect(rendered.match(/data-model-check="ok"/g)).toHaveLength(1);
    expect(rendered.match(/data-model-check="unchecked"/g)).toHaveLength(1);
    expect(rendered).not.toContain("Gateway pools");
    expect(rendered).not.toContain("LLM routes");
    expect(rendered).not.toContain("Re-login");
    expect(rendered).toContain("This provider does not report limits to the hub.");
    expect(rendered).toContain("Add provider");
    expect(rendered).toContain("Check all");
    expect(rendered).toContain("Actions for work@example.test");
    expect(rendered).toContain('aria-label="Permanently remove account work@example.test"');
    expect(rendered).toContain('data-workjet-action="models.account.account-a.remove-start"');
  });
  it("keeps the API key recognizer with its editable account identity", () => {
    const apiAccount: WorkjetGatewayAccountSummary = {
      ...first,
      provider: "zai",
      label: "Production",
      credentialKind: "api-key",
      credentialSuffix: "mAzP",
      modelIds: ["glm-5.3-flash"],
    };
    const rendered = html({ catalog: { ...state.catalog!, accounts: [apiAccount] } });
    expect(rendered).toContain('aria-label="Account name Production"');
    expect(rendered).toContain('aria-label="Edit API key for Production"');
    expect(rendered).toContain("API key ··mAzP");
    expect(html()).not.toContain("API key");
  });
  it("reveals re-login only when this enabled account has an authentication failure", () => {
    expect(
      html({ modelChecks: [{ ...check, status: "error", errorClass: "auth", httpStatus: 401 }] }),
    ).toContain("Re-login");
    expect(
      html({
        catalog: { ...state.catalog!, accounts: [{ ...first, enabled: false }] },
        modelChecks: [{ ...check, status: "error", errorClass: "auth" }],
      }),
    ).not.toContain("Re-login");
  });
  it("renders failed model checks as failures with an actionable model-specific class", () => {
    const rendered = html({
      modelChecks: [{ ...check, status: "error", errorClass: "unknown-model", httpStatus: 404 }],
    });
    expect(rendered).toContain('data-model-check="error"');
    expect(rendered).toContain("Unknown model · edit this model ID");
    expect(rendered).not.toContain('data-model-check="ok"');
  });
  it("does not offer re-login for a provider permission denial", () => {
    const denied = { ...check, status: "error" as const, errorClass: "auth", httpStatus: 403 };
    const rendered = html({ modelChecks: [denied] });
    expect(rendered).toContain("provider denied access (HTTP 403)");
    expect(rendered).not.toContain("Re-login");
    expect(modelCheckDescription(denied, false)).toContain("Access denied");
    expect(modelCheckDescription(denied, false)).not.toContain("sign in again");
  });

  it("shows gateway failures and old unverified errors as grey without a login demand", () => {
    for (const unavailable of [
      {
        ...check,
        status: "unavailable" as const,
        source: "gateway" as const,
        errorClass: null,
        httpStatus: 503,
        unavailableReason: "exact-account-unavailable" as const,
      },
      {
        ...check,
        status: "error" as const,
        source: undefined,
        errorClass: "auth",
        httpStatus: null,
      },
      {
        ...check,
        status: "error" as const,
        source: undefined,
        errorClass: "auth",
        httpStatus: 401,
      },
    ]) {
      const rendered = html({ modelChecks: [unavailable] });
      expect(rendered).toContain('data-model-check="unavailable"');
      expect(rendered).not.toContain('data-model-check="error"');
      expect(rendered).not.toContain("Re-login");
      expect(modelCheckDescription(unavailable, false)).toContain("Not checked");
      expect(modelCheckDescription(unavailable, false)).not.toContain("Authentication failed");
    }
  });
  it("keeps timing and old results honest during a new check", () => {
    expect(modelCheckDescription(undefined, false)).toBe("Not checked");
    expect(modelCheckDescription(undefined, true)).toBe("Checking this model");
    expect(modelCheckDescription(check, true)).toContain("354 ms");
    expect(modelCheckDescription(check, true)).toContain("checking again");
  });
  it("accepts direct comma-separated edits and rejects unsafe model IDs", () => {
    expect(parseModels("gpt-6.1-sol, gpt-6-luna, gpt-6.1-sol\nkimi-k3")).toEqual([
      "gpt-6.1-sol",
      "gpt-6-luna",
      "kimi-k3",
    ]);
    expect(parseModels("not a model")).toBeNull();
    expect(parseModels("bad\u0000id")).toBeNull();
    expect(parseModels("x".repeat(129))).toBeNull();
  });
});
