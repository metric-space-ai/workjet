import {
  WORKJET_GATEWAY_API_KEY_MAX_LENGTH,
  WorkjetGatewayAccountId,
  WorkjetGatewayOperationError,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayStatus,
} from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  canAddWorkjetGatewayAccount,
  maskGatewayCredentialSuffix,
  maskGatewayOauthState,
  WorkjetGatewayAccountsSectionView,
  gatewayAccountRotationLabel,
  workjetGatewayAccountsByProvider,
  workjetGatewayFailureDescription,
  workjetGatewayOauthSessionInvalidMessage,
  workjetGatewayPhaseSummary,
  WORKJET_GATEWAY_API_KEY_MAX_INPUT_LENGTH,
  WORKJET_GATEWAY_API_KEY_PROVIDERS,
  WORKJET_GATEWAY_OAUTH_POLL_INTERVAL_MS,
  WORKJET_GATEWAY_OAUTH_POLL_MAX_ATTEMPTS,
  WORKJET_GATEWAY_PROVIDERS,
  type WorkjetGatewayLoginState,
  type WorkjetGatewaySectionState,
} from "./WorkjetGatewayAccounts";

const READY_STATUS: WorkjetGatewayStatus = {
  schemaVersion: 1,
  phase: "ready",
  pid: 4_242,
  providerEndpoint: "http://127.0.0.1:8317",
  managementEndpoint: "http://127.0.0.1:8318",
  failureReason: null,
  configuredAccountCount: 2,
  configuredModelCount: 5,
};

const CATALOG: WorkjetGatewayCatalog = {
  schemaVersion: 1,
  accounts: [
    {
      id: WorkjetGatewayAccountId.make("account-claude-1"),
      label: "Claude Work",
      provider: "claude",
      enabled: true,
      priority: 1,
      weight: 1,
      modelIds: ["claude-opus", "claude-sonnet"],
      credentialSuffix: null,
    },
    {
      id: WorkjetGatewayAccountId.make("account-codex-1"),
      label: "Codex Personal",
      provider: "codex",
      enabled: false,
      priority: 2,
      weight: 1,
      modelIds: ["gpt-5.6"],
      credentialSuffix: null,
    },
    {
      id: WorkjetGatewayAccountId.make("account-zai-1"),
      label: "Z.ai key",
      provider: "zai",
      enabled: true,
      priority: 0,
      weight: 1,
      modelIds: [],
      credentialSuffix: "9xyz",
    },
  ],
  pools: [],
  routes: [],
  models: [],
  routingStrategy: "round-robin",
  providerPools: [
    {
      provider: "claude",
      strategy: "round-robin",
      weightHonored: false,
      priorityExclusive: true,
      members: [
        {
          accountId: WorkjetGatewayAccountId.make("account-claude-1"),
          label: "Claude Work",
          enabled: true,
          priority: 1,
          weight: 1,
          selectable: true,
        },
      ],
    },
  ],
};

const BASE: WorkjetGatewaySectionState = {
  status: READY_STATUS,
  catalog: CATALOG,
  isInitialLoading: false,
  isRefreshing: false,
  statusError: null,
  catalogError: null,
  isOperating: false,
  login: { status: "idle" },
  onRefresh: () => undefined,
  onRetry: () => undefined,
  onAddAccount: () => undefined,
  onCancelLogin: () => undefined,
  apiKey: { status: "idle" },
  onRemoveAccount: () => undefined,
  onAddApiKey: () => undefined,
};

function render(overrides: Partial<WorkjetGatewaySectionState> = {}) {
  return renderToStaticMarkup(<WorkjetGatewayAccountsSectionView {...BASE} {...overrides} />);
}

describe("Workjet gateway account surface", () => {
  it("derives Kimi discovery errors only from the typed reason, never an echoed key", () => {
    const message = workjetGatewayFailureDescription({
      _tag: "WorkjetGatewayOperationError",
      reason: "kimi-key-not-accepted",
      message: "provider echoed private-fixture-key",
    });
    expect(message).toContain("GET /models");
    expect(message).toContain("https://api.kimi.com/coding/v1");
    expect(message).toContain("https://api.kimi.ai/coding/v1");
    expect(message).toContain("https://api.moonshot.ai/v1");
    expect(message).toContain("https://api.moonshot.cn/v1");
    expect(message).not.toContain("private-fixture-key");
  });
  it.each(["api-key-model-list-unavailable", "invalid-model-selection"] as const)(
    "shows the secret-free %s retry from the typed contract",
    (reason) => {
      const message = workjetGatewayFailureDescription({
        _tag: "WorkjetGatewayOperationError",
        reason,
        message: "provider echoed private-fixture-key",
      });
      expect(message).toContain("live model list");
      expect(message).toContain("retry");
      expect(message).not.toContain("private-fixture-key");
      expect(message).not.toContain("Credentials rejected");
    },
  );
  it("lists every gateway provider with its accounts, enablement, and model count", () => {
    const markup = render();

    expect(markup).toContain("Claude");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Antigravity");
    expect(markup).toContain("Claude Work");
    expect(markup).toContain("In Rotation");
    expect(markup).toContain("2 Kontomuster");
    expect(markup).toContain("erfasst");
    expect(markup).toContain("Codex Personal");
    expect(markup).toContain("Deaktiviert");
    expect(markup).toContain("1 Kontomuster");
    expect(markup).toContain("Zählweise der Modelle");
    // One Row per account, no explanatory row description.
    expect(markup.match(/data-slot="row"/g)).toHaveLength(3);
    expect(markup).not.toContain("Connect the LLM accounts");
    // The prose that used to sit here — "No accounts are configured for this
    // provider." — said exactly what the button beside it says, seven times
    // over, and turned the page into something nobody could scan. Absence of
    // accounts is now shown by the provider sitting under "Available".
    expect(markup).not.toContain("No accounts are configured");
    expect(markup).toContain("Verbunden");
    expect(markup).toContain("Verfügbar");
    expect(markup).toContain("Konto hinzufügen");
    // The happy path never asks the user to start or stop anything: the server
    // starts the gateway when a login begins.
    expect(markup).not.toContain("Start gateway");
    expect(markup).not.toContain("Stop gateway");
    expect(markup).not.toContain("Gateway neu starten");
  });

  it("selects accounts by gateway provider only", () => {
    expect(workjetGatewayAccountsByProvider(CATALOG, "claude").map((a) => a.label)).toEqual([
      "Claude Work",
    ]);
    expect(workjetGatewayAccountsByProvider(CATALOG, "antigravity")).toEqual([]);
    expect(workjetGatewayAccountsByProvider(null, "claude")).toEqual([]);
  });

  it("still offers no start control while the gateway is merely stopped", () => {
    const markup = render({
      status: { ...READY_STATUS, phase: "stopped", pid: null, providerEndpoint: null },
    });

    expect(markup).toContain("Gestoppt");
    expect(markup).not.toContain("Start gateway");
    expect(markup).not.toContain("Gateway neu starten");
  });

  it("hides the raw endpoint and offers a retry with the reason when faulted", () => {
    expect(render()).not.toContain("http://127.0.0.1:8317");
    expect(render()).toContain("Bereit · 2 Konten · 5 Modelle");

    const markup = render({
      status: {
        ...READY_STATUS,
        phase: "faulted",
        pid: null,
        providerEndpoint: null,
        failureReason: "process-exit",
      },
    });

    expect(markup).toContain("Gateway neu starten");
    expect(markup).toContain("The Workjet provider gateway process exited unexpectedly.");
    expect(markup).not.toContain("Start gateway");
  });

  it("shows the pending login without the handle and with a cancel control", () => {
    const login: WorkjetGatewayLoginState = {
      status: "pending",
      provider: "claude",
      state: "abcdefghijklmnop",
      authorizationUrl: "https://provider.example.test/authorize?code=1",
    };
    const markup = render({ login });

    expect(markup).toContain("Claude-Anmeldung im Browser abschließen.");
    // The opaque handle and the authorization URL never reach the rendered page.
    expect(markup).not.toContain("abcd…mnop");
    expect(markup).not.toContain("abcdefghijklmnop");
    expect(markup).not.toContain("provider.example.test");
    expect(markup).toContain("Anmeldung abbrechen");
    expect(markup).not.toContain("Workjet never sees your credentials.");
  });

  it("masks short handles entirely", () => {
    expect(maskGatewayOauthState("abcd")).toBe("••••");
    expect(maskGatewayOauthState("  ")).toBe("•");
  });

  it("shows a failed login using the contract's own reason copy", () => {
    const markup = render({
      login: {
        status: "failed",
        provider: "codex",
        message: workjetGatewayFailureDescription(
          new WorkjetGatewayOperationError({ reason: "oauth-unavailable" }),
        ),
      },
    });

    expect(markup).toContain("The Workjet provider gateway login flow is unavailable.");
    expect(markup).toContain('role="alert"');
  });

  it("confirms a completed login", () => {
    expect(
      render({
        login: {
          status: "completed",
          provider: "antigravity",
          accountIds: ["account-antigravity-1"],
        },
      }),
    ).toContain("Antigravity-Konto hinzugefügt.");
    expect(
      render({
        login: { status: "completed", provider: "claude", accountIds: ["a", "b"] },
      }),
    ).toContain("2 Claude-Konten hinzugefügt.");
  });

  it("surfaces a catalog failure without hiding the provider list", () => {
    const markup = render({
      catalog: null,
      catalogError: new WorkjetGatewayOperationError({ reason: "gateway-not-ready" }).message,
    });

    expect(markup).toContain("The Workjet provider gateway is not running.");
    expect(markup).toContain("Antigravity");
  });

  it("keeps every documented operation reason on the contract's wording", () => {
    expect(
      workjetGatewayFailureDescription(
        new WorkjetGatewayOperationError({ reason: "secret-unavailable" }),
      ),
    ).toBe("A Workjet provider gateway credential is unavailable.");
    expect(workjetGatewayFailureDescription({ _tag: "SomethingElse" })).toBe(
      "Gateway-Vorgang fehlgeschlagen.",
    );
    expect(workjetGatewayFailureDescription(new Error("boom"))).toBe(
      "Gateway-Vorgang fehlgeschlagen.",
    );
    expect(workjetGatewayOauthSessionInvalidMessage()).toBe(
      "The Workjet provider gateway login session is invalid or expired.",
    );
  });

  it("summarizes each runtime phase from the reported status", () => {
    expect(workjetGatewayPhaseSummary(null)).toBe("Kein Rechner gewählt");
    expect(workjetGatewayPhaseSummary(READY_STATUS)).toBe("Bereit · 2 Konten · 5 Modelle");
    expect(workjetGatewayPhaseSummary({ ...READY_STATUS, phase: "starting" })).toBe("Startet …");
    expect(
      workjetGatewayPhaseSummary({
        ...READY_STATUS,
        phase: "faulted",
        failureReason: "process-exit",
      }),
    ).toBe("The Workjet provider gateway process exited unexpectedly.");
  });

  it("allows adding an account whenever the gateway can be autostarted", () => {
    expect(
      canAddWorkjetGatewayAccount({ status: READY_STATUS, login: BASE.login, isOperating: false }),
    ).toBe(true);
    expect(
      canAddWorkjetGatewayAccount({ status: READY_STATUS, login: BASE.login, isOperating: true }),
    ).toBe(false);
    expect(
      canAddWorkjetGatewayAccount({
        status: READY_STATUS,
        login: { status: "pending", provider: "claude", state: "s", authorizationUrl: "u" },
        isOperating: false,
      }),
    ).toBe(false);
    // The server autostarts the gateway for the login, so a stopped gateway
    // must not strand a surface that has no start button.
    expect(
      canAddWorkjetGatewayAccount({
        status: { ...READY_STATUS, phase: "stopped" },
        login: BASE.login,
        isOperating: false,
      }),
    ).toBe(true);
    expect(
      canAddWorkjetGatewayAccount({
        status: { ...READY_STATUS, phase: "faulted", failureReason: "process-exit" },
        login: BASE.login,
        isOperating: false,
      }),
    ).toBe(false);
    expect(
      canAddWorkjetGatewayAccount({ status: null, login: BASE.login, isOperating: false }),
    ).toBe(false);
  });

  it("bounds the login poll to roughly five minutes", () => {
    expect(WORKJET_GATEWAY_OAUTH_POLL_INTERVAL_MS).toBe(3_000);
    const totalMs =
      WORKJET_GATEWAY_OAUTH_POLL_INTERVAL_MS * WORKJET_GATEWAY_OAUTH_POLL_MAX_ATTEMPTS;
    expect(totalMs).toBeGreaterThanOrEqual(4 * 60_000);
    expect(totalMs).toBeLessThanOrEqual(6 * 60_000);
  });
});

describe("WorkjetGatewayAccounts · API-key providers", () => {
  it("lists every API-key provider beside the OAuth providers", () => {
    const markup = render();
    for (const label of [
      "Claude",
      "Codex",
      "Antigravity",
      "Z.ai (GLM)",
      "MiniMax",
      "xAI (Grok)",
      "Kimi (Moonshot)",
    ]) {
      expect(markup, label).toContain(label);
    }
    expect(WORKJET_GATEWAY_API_KEY_PROVIDERS).toEqual(["zai", "minimax", "xai", "kimi"]);
    expect(WORKJET_GATEWAY_PROVIDERS).toHaveLength(7);
  });

  it("offers 'API-Key hinzufügen' for key providers and 'Konto hinzufügen' for OAuth providers", () => {
    const markup = render();
    expect(markup).toContain("API-Key hinzufügen");
    expect(markup).toContain("Konto hinzufügen");
  });

  it("shows only the masked suffix for an API-key account, never a key", () => {
    const markup = render();
    expect(markup).toContain("Z.ai key");
    expect(markup).toContain("API-Key ••••9xyz");
    expect(maskGatewayCredentialSuffix("9xyz")).toBe("API-Key ••••9xyz");
    expect(maskGatewayCredentialSuffix(null)).toBeNull();
    expect(maskGatewayCredentialSuffix("   ")).toBeNull();
    // Nothing in the rendered list resembles a full credential.
    expect(markup).not.toContain("sk-");
    expect(markup).not.toContain('type="password"');
  });

  it("blocks adding while a key is in flight and reports a failure in place", () => {
    expect(
      canAddWorkjetGatewayAccount({
        status: READY_STATUS,
        login: BASE.login,
        isOperating: false,
        apiKey: { status: "saving", provider: "zai" },
      }),
    ).toBe(false);
    expect(
      canAddWorkjetGatewayAccount({
        status: READY_STATUS,
        login: BASE.login,
        isOperating: false,
        apiKey: { status: "idle" },
      }),
    ).toBe(true);

    const failed = render({
      apiKey: { status: "failed", provider: "xai", message: "The key could not be stored." },
    });
    expect(failed).toContain("The key could not be stored.");
    const saving = render({ apiKey: { status: "saving", provider: "kimi" } });
    expect(saving).toContain("Kimi (Moonshot)-Key wird gespeichert …");
    const done = render({ apiKey: { status: "completed", provider: "minimax" } });
    expect(done).toContain("MiniMax-Konto hinzugefügt.");
  });

  it("keeps the key input bounded exactly like the contract", () => {
    expect(WORKJET_GATEWAY_API_KEY_MAX_INPUT_LENGTH).toBe(WORKJET_GATEWAY_API_KEY_MAX_LENGTH);
  });

  /**
   * "Enabled" on an account the gateway is holding back behind a higher
   * priority is a false claim, so the row reports the pool's live eligibility
   * whenever the catalog carries one.
   */
  it("reports pool eligibility per account, and falls back only when no pool exists", () => {
    const [claude, codex] = CATALOG.accounts;
    expect(gatewayAccountRotationLabel(CATALOG, claude!)).toBe("In Rotation");
    // No pool for codex in this catalog: nothing is asserted about it.
    expect(gatewayAccountRotationLabel(CATALOG, codex!)).toBeNull();
    expect(gatewayAccountRotationLabel(null, claude!)).toBeNull();

    const heldBack = {
      ...CATALOG,
      providerPools: [
        {
          ...CATALOG.providerPools[0]!,
          members: [{ ...CATALOG.providerPools[0]!.members[0]!, selectable: false }],
        },
      ],
    };
    expect(gatewayAccountRotationLabel(heldBack, claude!)).toBe("Zurückgestellt");
    expect(render({ catalog: heldBack })).toContain("Zurückgestellt");
  });
});
