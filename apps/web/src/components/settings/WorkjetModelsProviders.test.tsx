import { InstanceProviderSection, InstanceConnectionStatus } from "./InstanceProviderSection";
import {
  WorkjetGatewayAccountId,
  WorkjetGatewayOperationError,
  type WorkjetGatewayAccountSummary,
} from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readProviderDraft, setProviderDraft } from "./providerDraft";
import {
  WorkjetModelsProviders,
  WorkjetModelsKeyForm,
  type ModelsManagementState,
  type ModelsModelCheck,
} from "./WorkjetModelsProviders";
import type { WorkjetGatewaySectionState } from "./WorkjetGatewayAccounts";
import { modelCheckDescription } from "./WorkjetModelsCell";
import { parseModels } from "./WorkjetModelsFields";
import { modelsAccountHealth } from "./WorkjetModelsHealth";

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
  it("renders shrinking remaining bars, unknown reasons and exhaustion only at zero", () => {
    const base = {
      accountId: first.id,
      provider: "codex" as const,
      authentication: "authenticated" as const,
      disabled: false,
      usable: true,
      cooldownUntilMs: 5000,
      errorCode: null,
      httpStatus: 429,
      generationHttpStatus: 429,
      observedAtMs: 1000,
      balance: null,
      quotaSupported: true,
      quotaRefreshing: false,
      quotaError: null,
    };
    for (const [remainingPercent, color] of [
      [100, "bg-emerald-500/80"],
      [20, "bg-amber-500"],
      [5, "bg-red-500"],
      [0, "bg-red-500"],
    ] as const) {
      const health = modelsAccountHealth(
        {
          ...base,
          quota: [
            {
              name: "primary_window",
              remainingPercent,
              resetsAtMs: 5000,
              observedAtMs: 1000,
              modelPattern: null,
              toolOnly: false,
              notInPlan: false,
              unlimited: false,
              boostPermille: null,
            },
          ],
        },
        2000,
      );
      const rendered = html({ accountHealth: { [first.id]: health } });
      expect(rendered).toContain(`width:${remainingPercent}%`);
      expect(rendered).toContain(color);
      expect(rendered.includes("Limit erreicht")).toBe(remainingPercent === 0);
      expect(rendered).toContain(`aria-valuenow="${remainingPercent}"`);
    }
    const health = modelsAccountHealth(
      {
        ...base,
        provider: "xai",
        quota: [
          {
            name: "unexpected",
            remainingPercent: 100,
            resetsAtMs: 5000,
            observedAtMs: 1000,
            modelPattern: null,
            toolOnly: false,
            notInPlan: false,
            unlimited: false,
            boostPermille: null,
          },
        ],
      },
      2000,
    );
    const rendered = html({ accountHealth: { [first.id]: health } });
    // #610: unknown limits are hidden, no "unbekannt".
    expect(rendered).not.toContain("unbekannt");
    expect(rendered).not.toContain("Limit erreicht");
    expect(rendered).not.toContain('role="meter"');
  });
  it("keeps instance rows without a status line while local xAI remains active and verified", () => {
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
            check: async () => undefined,
            refresh: async () => undefined,
          }}
          grok={{
            row: <div>xAI · Welsch · Not loaded</div>,
            connectionFailure: failure,
            label: "Welsch",
            installed: false,
            hasModels: false,
            checking: false,
            start: async () => null,
            checkAll: () => {},
            refresh: () => {},
          }}
        />
      ),
    });
    // A transport outage is retried silently: no status line, the last rows stay.
    expect(rendered).not.toContain("data-workjet-instance-connection");
    expect(rendered).not.toContain("nicht erreichbar");
    expect(rendered).toContain("Instanz Welsch");
    expect(rendered).toContain("Dieser Rechner");
    expect(rendered).not.toContain("guest_failed");
    expect(rendered).toContain("xAI · Welsch");
    expect(rendered).toContain("work@example.test");
    expect(rendered).toContain("grok-4.7");
    expect(rendered).toContain("200");
  });
  it("shows a German instance status without raw diagnostics", () => {
    const rendered = renderToStaticMarkup(
      <InstanceConnectionStatus
        label="Welsch"
        failure={{
          _tag: "failed",
          code: "guest_failed",
          preparation: { stage: "session", reason: "unknown" },
        }}
        busy={false}
        reconnect={() => {}}
      />,
    );
    expect(rendered).toContain("Welsch");
    expect(rendered).toContain("Neu verbinden");
    expect(rendered).not.toContain("<details>");
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
    expect(rendered).toContain("Zeitüberschreitung");
    expect(rendered).toContain(">Erneut prüfen</button>");
    expect(rendered).not.toContain("Neu anmelden");
    expect(rendered).not.toContain('data-model-check="running"');
    expect(modelCheckDescription(timeout, false)).toContain("Zeitüberschreitung");
  });
  it("shows stacked accounts with their own editable models and only their own check result", () => {
    const rendered = html();
    expect(rendered.match(/data-slot="row"/g)).toHaveLength(2);
    expect(rendered).not.toContain('role="table"');
    expect(rendered).not.toContain('data-slot="popover-trigger"');
    expect(rendered).toContain('value="work@example.test"');
    expect(rendered).toContain('value="backup@example.test"');
    expect(rendered).toContain('value="grok-4.7"');
    expect(rendered).toContain('value="grok-4.6"');
    expect(rendered.match(/data-model-check="ok"/g)).toHaveLength(1);
    expect(rendered.match(/data-model-check="unchecked"/g)).toHaveLength(1);
    expect(rendered).not.toContain("Gateway pools");
    expect(rendered).not.toContain("LLM routes");
    expect(rendered).not.toContain("Neu anmelden");
    expect(rendered).not.toContain("Anbieter meldet kein Limit");
    expect(rendered).toContain("Hinzufügen");
    expect(rendered).toContain("Alle prüfen");
    expect(rendered).toContain("Aktionen für work@example.test");
    expect(rendered).toContain('aria-label="Entfernen"');
    expect(rendered).toContain('aria-label="Konto work@example.test verwenden"');
    expect(rendered).toContain('data-workjet-action="models.add-provider"');
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
    expect(rendered).toContain('aria-label="Kontoname Production"');
    expect(rendered).toContain("Aktionen für Production");
    expect(rendered).toContain("API-Key ··mAzP");
    expect(html()).not.toContain("API-Key");
  });
  it.each([
    {
      plan: "coding" as const,
      upstreamBaseUrl: "https://api.kimi.com/coding/v1" as const,
      title: "Coding-Plan",
    },
    {
      plan: "api" as const,
      upstreamBaseUrl: "https://api.moonshot.cn/v1" as const,
      title: "API-Plan",
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
      expect(rendered).toContain("API-Key ··abcd");
      // The verified endpoint is a tooltip, not visible text.
      expect(rendered).toContain(`title="${kimiConnection.upstreamBaseUrl}"`);
      expect(rendered).not.toContain("<select");
    },
  );
  it("reveals re-login only when this enabled account has an authentication failure", () => {
    expect(
      html({ modelChecks: [{ ...check, status: "error", errorClass: "auth", httpStatus: 401 }] }),
    ).toContain("Neu anmelden");
    expect(
      html({
        catalog: { ...state.catalog!, accounts: [{ ...first, enabled: false }] },
        modelChecks: [{ ...check, status: "error", errorClass: "auth" }],
      }),
    ).not.toContain("Neu anmelden");
  });
  it("renders failed model checks as failures with an actionable model-specific class", () => {
    const rendered = html({
      modelChecks: [{ ...check, status: "error", errorClass: "unknown-model", httpStatus: 404 }],
    });
    expect(rendered).toContain('data-model-check="error"');
    expect(rendered).toContain("Unbekanntes Modell · Modell-ID prüfen");
    expect(rendered).not.toContain('data-model-check="ok"');
  });
  it("does not offer re-login for a provider permission denial", () => {
    const denied = { ...check, status: "error" as const, errorClass: "auth", httpStatus: 403 };
    const rendered = html({ modelChecks: [denied] });
    expect(rendered).toContain("Zugriff verweigert (HTTP 403)");
    expect(rendered).not.toContain("Neu anmelden");
    expect(modelCheckDescription(denied, false)).toContain("Zugriff verweigert");
    expect(modelCheckDescription(denied, false)).not.toContain("neu anmelden");
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
      expect(rendered).not.toContain("Neu anmelden");
      expect(modelCheckDescription(unavailable, false)).toContain("Nicht geprüft");
      expect(modelCheckDescription(unavailable, false)).not.toContain("Anmeldung fehlgeschlagen");
    }
  });
  it("keeps timing and old results honest during a new check", () => {
    expect(modelCheckDescription(undefined, false)).toBe("Nicht geprüft");
    expect(modelCheckDescription(undefined, true)).toBe("Prüft …");
    expect(modelCheckDescription(check, true)).toContain("354 ms");
    expect(modelCheckDescription(check, true)).toContain("prüft erneut");
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
  it("offers model suggestions as an inline toggle, never a popover", () => {
    const rendered = html({
      catalog: {
        ...state.catalog!,
        accounts: [{ ...first, provider: "kimi", modelIds: ["k3"] }],
        providerModels: [{ provider: "kimi", modelIds: ["k3"] }],
      },
      onEditProviderModels: async () => true,
      onExcludeModel: async () => true,
      modelSuggestions: { kimi: ["k3", "kimi-for-coding"] },
    });
    // #610: model editing opens from the row menu; no second "+" in a provider header.
    expect(rendered).not.toContain('aria-label="Modellvorschläge für Kimi (Moonshot)"');
    expect(rendered).toContain("Aktionen für work@example.test");
    expect(rendered).not.toContain('data-slot="popover-trigger"');
    expect(rendered).not.toContain('aria-haspopup="dialog"');
    // Closed by default: the suggestion list expands below the field on click.
    expect(rendered).not.toContain('role="group" aria-label="Modellvorschläge');
  });
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
    // Provider-wide model list is edited inline via the row menu (#610), closed by default.
    expect(rendered).not.toContain('data-workjet-action="models.provider.kimi.models"');
    expect(rendered).toContain('aria-label="k3 für work@example.test verwenden"');
    expect(rendered).toContain("Für dieses Konto ausgeschlossen");
    expect(rendered).not.toContain('aria-label="Modell hinzufügen für work@example.test"');
    expect(rendered).not.toContain('aria-label="Modell k3 für work@example.test"');
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
    expect(rendered).toContain("Nicht in der Live-Modellliste des Kontos");
    expect(rendered).toContain('aria-label="kimi-for-coding für work@example.test verwenden"');
    expect(rendered).toContain('disabled=""');
  });
});

describe("Provider draft card", () => {
  const grok = {
    row: <div>xAI · Welsch</div>,
    label: "Welsch",
    installed: false,
    hasModels: false,
    checking: false,
    start: async () => "guest_failed",
    checkAll: () => {},
    refresh: () => {},
  };
  afterEach(() => setProviderDraft(null));

  it("shows a chosen provider as a full row inside the account list, with the choice inline", () => {
    setProviderDraft({ provider: "xai", mode: "subscription", keyFormOpen: false });
    const rendered = html({ instanceGrok: grok });
    const list = rendered.slice(rendered.indexOf('data-testid="models-accounts"'));
    expect(list).toContain('data-provider-draft="xai"');
    expect(list).toContain("xAI (Grok)");
    expect(list).toContain("Abo");
    expect(list).toContain("API-Key");
    expect(list).toContain("Anmelden");
    expect(list).toContain("Auf Welsch anmelden");
    expect(list).toContain("Entfernen");
    expect(list).toContain('role="switch"');
  });

  it("opens the key field in the same row for a key-only provider", () => {
    setProviderDraft({ provider: "zai", mode: "key", keyFormOpen: true });
    const rendered = html({ catalog: { ...state.catalog!, accounts: [] } });
    expect(rendered).toContain('data-provider-draft="zai"');
    expect(rendered).toContain("API-Key für Z.ai (GLM)");
    expect(rendered).not.toContain("Keine Anbieter");
  });

  it("keeps the draft when the key form collapses and offers to reopen it", () => {
    setProviderDraft({ provider: "kimi", mode: "key", keyFormOpen: false });
    const rendered = html();
    expect(rendered).toContain('data-provider-draft="kimi"');
    expect(rendered).toContain("API-Key eingeben");
  });

  it("does not reset the draft when the section is rendered again", () => {
    setProviderDraft({ provider: "xai", mode: "key", keyFormOpen: true });
    html();
    expect(readProviderDraft()?.provider).toBe("xai");
    expect(html()).toContain('data-provider-draft="xai"');
  });
});
