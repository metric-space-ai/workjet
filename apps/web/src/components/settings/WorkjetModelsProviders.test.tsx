import { InstanceProviderSection, InstanceConnectionStatus } from "./InstanceProviderSection";
import {
  WorkjetGatewayAccountId,
  WorkjetGatewayOperationError,
  type WorkjetGatewayAccountSummary,
} from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  WorkjetModelsProviders,
  WorkjetModelsKeyForm,
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
  modelIds: ["grok-4.6"],
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
  it("groups an instance outage once while local xAI remains active and verified", () => {
    const failure = {
      _tag: "failed" as const,
      code: "guest_failed" as const,
      preparation: {
        stage: "navigation_commit" as const,
        reason: "did_fail_load" as const,
        errorCode: -102,
      },
    };
    const rendered = html({
      nativeProviderRows: (
        <InstanceProviderSection
          label="Welsch"
          providers={{
            registry: undefined,
            error: "CTOX: guest_failed",
            errorAccountId: undefined,
            connectionFailure: failure,
            busy: false,
            run: async () => undefined,
            refresh: async () => undefined,
          }}
          grok={{
            row: <div>xAI · Welsch · Not loaded</div>,
            connectionFailure: failure,
            label: "Welsch",
            installed: false,
            hasModels: false,
            checking: false,
            start: () => {},
            checkAll: () => {},
            refresh: () => {},
          }}
        />
      ),
    });
    expect(rendered.match(/data-workjet-instance-connection=/g)).toHaveLength(1);
    expect(rendered).toContain("Instance Welsch");
    expect(rendered).toContain("This computer");
    expect(rendered).toContain("navigation_commit");
    expect(rendered).toContain("Reconnect");
    expect(rendered).not.toContain("guest_failed");
    expect(rendered).not.toContain("Not loaded");
    expect(rendered).toContain("work@example.test");
    expect(rendered).toContain("grok-4.7");
    expect(rendered).toContain("200");
  });
  it("shows a German instance status and safe diagnostic disclosure", () => {
    const rendered = renderToStaticMarkup(
      <InstanceConnectionStatus
        label="Welsch"
        language="de"
        failure={{
          _tag: "failed",
          code: "guest_failed",
          preparation: { stage: "session", reason: "unknown" },
        }}
        busy={false}
        reconnect={() => {}}
      />,
    );
    expect(rendered).toContain("Verbindung zur Instanz Welsch gestört");
    expect(rendered).toContain("Neu verbinden");
    expect(rendered).toContain("<details>");
    expect(rendered).toContain("Sitzung vorbereiten");
    expect(rendered).not.toContain("guest_failed");
    expect(rendered).not.toContain("text-destructive");
  });

  it("shows the safe endpoint discovery failure inside the Kimi key form", () => {
    const message = new WorkjetGatewayOperationError({ reason: "kimi-key-not-accepted" }).message;
    const rendered = renderToStaticMarkup(
      <WorkjetModelsKeyForm
        provider="kimi"
        models={[]}
        onClose={() => {}}
        state={{ ...state, apiKey: { status: "failed", provider: "kimi", message } }}
      />,
    );
    expect(rendered).toContain('role="alert"');
    expect(rendered).toContain("https://api.moonshot.cn/v1");
    expect(rendered).toContain("https://api.kimi.com/coding/v1");
    expect(rendered).not.toContain("<select");
    expect(rendered).not.toContain("control plane is unavailable");
    expect(rendered).not.toContain("Credentials rejected");
  });
  it("keeps a failed key replacement with the account that submitted it", () => {
    const message = new WorkjetGatewayOperationError({ reason: "kimi-key-not-accepted" }).message;
    for (const failedAccountId of [first.id, second.id]) {
      const rendered = renderToStaticMarkup(
        <WorkjetModelsKeyForm
          provider="kimi"
          account={{ ...first, provider: "kimi", modelIds: ["k3"] }}
          models={["k3"]}
          onClose={() => {}}
          state={{
            ...state,
            apiKey: {
              status: "failed",
              provider: "kimi",
              accountId: failedAccountId,
              message,
            },
          }}
        />,
      );
      expect(rendered.includes('role="alert"')).toBe(failedAccountId === first.id);
    }
  });
  it("shows a timeout with a direct retry and no false authentication failure", () => {
    const timeout: ModelsModelCheck = {
      ...check,
      status: "unavailable",
      source: "gateway",
      errorClass: null,
      httpStatus: null,
      unavailableReason: "timeout",
      latencyMs: 20000,
    };
    const rendered = html({ modelChecks: [timeout] });
    expect(rendered).toContain('data-model-check="unavailable"');
    expect(rendered).toContain("Check timed out");
    expect(rendered).toContain(">Retry</button>");
    expect(rendered).not.toContain("Re-login");
    expect(rendered).not.toContain('data-model-check="running"');
    expect(modelCheckDescription(timeout, false)).toContain("Check timed out");
  });
  it("shows stacked accounts with their own editable models and only their own check result", () => {
    const rendered = html();
    expect(rendered).toContain('role="table"');
    expect(rendered).toContain("Provider / account");
    expect(rendered).toContain('value="work@example.test"');
    expect(rendered).toContain('value="backup@example.test"');
    expect(rendered).toContain('value="grok-4.7"');
    expect(rendered).toContain('value="grok-4.6"');
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
  it.each([
    {
      plan: "coding" as const,
      upstreamBaseUrl: "https://api.kimi.com/coding/v1" as const,
      title: "Coding plan",
    },
    {
      plan: "api" as const,
      upstreamBaseUrl: "https://api.moonshot.cn/v1" as const,
      title: "API plan",
    },
  ])(
    "shows $title and its verified endpoint directly on the account",
    ({ title, ...kimiConnection }) => {
      const account: WorkjetGatewayAccountSummary = {
        ...first,
        provider: "kimi",
        label: "Kimi work",
        credentialKind: "api-key",
        credentialSuffix: "abcd",
        modelIds: ["k3"],
        kimiConnection,
      };
      const rendered = html({ catalog: { ...state.catalog!, accounts: [account] } });
      expect(rendered).toContain(title);
      expect(rendered).toContain(kimiConnection.upstreamBaseUrl);
      expect(rendered).toContain("API key ··abcd");
      expect(rendered).not.toContain("<select");
    },
  );
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

describe("shared provider models", () => {
  it("edits models once per provider and offers only account exclusions", () => {
    const account = {
      ...first,
      provider: "kimi" as const,
      modelIds: ["k3"],
      availableModelIds: ["k3", "kimi-for-coding"],
      excludedModelIds: ["kimi-for-coding"],
    };
    const rendered = html({
      catalog: {
        ...state.catalog!,
        accounts: [account],
        providerModels: [{ provider: "kimi", modelIds: ["k3", "kimi-for-coding"] }],
      },
      onEditProviderModels: async () => true,
      onExcludeModel: async () => true,
    });
    expect(rendered).toContain('data-workjet-action="models.provider.kimi.models"');
    expect(rendered).toContain("k3, kimi-for-coding");
    expect(rendered).toContain('aria-label="Use k3 for work@example.test"');
    expect(rendered).toContain("Excluded for this account");
    expect(rendered).not.toContain('aria-label="Add model for work@example.test"');
    expect(rendered).not.toContain('aria-label="Model k3 for work@example.test"');
  });
  it("does not activate a model absent from this account's live list", () => {
    const rendered = html({
      catalog: {
        ...state.catalog!,
        accounts: [{ ...first, provider: "kimi", modelIds: ["k3"], availableModelIds: ["k3"] }],
        providerModels: [{ provider: "kimi", modelIds: ["k3", "kimi-for-coding"] }],
      },
      onEditProviderModels: async () => true,
      onExcludeModel: async () => true,
    });
    expect(rendered).toContain("Not offered by this account&#x27;s live model list");
    expect(rendered).toContain('aria-label="Use kimi-for-coding for work@example.test"');
    expect(rendered).toContain('disabled=""');
  });
});
