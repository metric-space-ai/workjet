import {
  WorkjetGatewayAccountId,
  WorkjetGatewayOperationError,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayStatus,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  canAddWorkjetGatewayAccount,
  maskGatewayOauthState,
  WorkjetGatewayAccountsSectionView,
  workjetGatewayAccountsByProvider,
  workjetGatewayFailureDescription,
  workjetGatewayOauthSessionInvalidMessage,
  workjetGatewayPhaseSummary,
  WORKJET_GATEWAY_OAUTH_POLL_INTERVAL_MS,
  WORKJET_GATEWAY_OAUTH_POLL_MAX_ATTEMPTS,
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
    },
    {
      id: WorkjetGatewayAccountId.make("account-codex-1"),
      label: "Codex Personal",
      provider: "codex",
      enabled: false,
      priority: 2,
      weight: 1,
      modelIds: ["gpt-5.6"],
    },
  ],
  pools: [],
  routes: [],
  models: [],
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
};

function render(overrides: Partial<WorkjetGatewaySectionState> = {}) {
  return renderToStaticMarkup(<WorkjetGatewayAccountsSectionView {...BASE} {...overrides} />);
}

describe("Workjet gateway account surface", () => {
  it("lists every gateway provider with its accounts, enablement, and model count", () => {
    const markup = render();

    expect(markup).toContain("Claude");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Antigravity");
    expect(markup).toContain("Claude Work");
    expect(markup).toContain("Enabled");
    expect(markup).toContain("2 models");
    expect(markup).toContain("Codex Personal");
    expect(markup).toContain("Disabled");
    expect(markup).toContain("1 model");
    expect(markup).toContain("No accounts are configured for this provider.");
    expect(markup).toContain("Add account");
    // The happy path never asks the user to start or stop anything: the server
    // starts the gateway when a login begins.
    expect(markup).not.toContain("Start gateway");
    expect(markup).not.toContain("Stop gateway");
    expect(markup).not.toContain("Retry gateway");
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

    expect(markup).toContain("Stopped");
    expect(markup).not.toContain("Start gateway");
    expect(markup).not.toContain("Retry gateway");
  });

  it("shows the endpoint on a ready gateway and a retry with the reason when faulted", () => {
    expect(render()).toContain("http://127.0.0.1:8317");

    const markup = render({
      status: {
        ...READY_STATUS,
        phase: "faulted",
        pid: null,
        providerEndpoint: null,
        failureReason: "process-exit",
      },
    });

    expect(markup).toContain("Retry gateway");
    expect(markup).toContain("The Workjet provider gateway process exited unexpectedly.");
    expect(markup).not.toContain("Start gateway");
  });

  it("shows the pending login with a masked handle and a cancel control", () => {
    const login: WorkjetGatewayLoginState = {
      status: "pending",
      provider: "claude",
      state: "abcdefghijklmnop",
      authorizationUrl: "https://provider.example.test/authorize?code=1",
    };
    const markup = render({ login });

    expect(markup).toContain("Finish the Claude login in your browser");
    expect(markup).toContain("abcd…mnop");
    // The opaque handle and the authorization URL never reach the rendered page.
    expect(markup).not.toContain("abcdefghijklmnop");
    expect(markup).not.toContain("provider.example.test");
    expect(markup).toContain("Cancel login");
    expect(markup).toContain("Workjet never sees your credentials.");
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
    ).toContain("Added one Antigravity account.");
    expect(
      render({
        login: { status: "completed", provider: "claude", accountIds: ["a", "b"] },
      }),
    ).toContain("Added 2 Claude accounts.");
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
      "The Workjet provider gateway operation failed.",
    );
    expect(workjetGatewayFailureDescription(new Error("boom"))).toBe(
      "The Workjet provider gateway operation failed.",
    );
    expect(workjetGatewayOauthSessionInvalidMessage()).toBe(
      "The Workjet provider gateway login session is invalid or expired.",
    );
  });

  it("summarizes each runtime phase from the reported status", () => {
    expect(workjetGatewayPhaseSummary(null)).toContain("Select a primary environment");
    expect(workjetGatewayPhaseSummary(READY_STATUS)).toBe("Ready · 2 accounts · 5 models");
    expect(workjetGatewayPhaseSummary({ ...READY_STATUS, phase: "starting" })).toBe("Starting…");
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
