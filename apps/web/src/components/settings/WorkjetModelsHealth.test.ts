import { describe, expect, it } from "vite-plus/test";
import type { WorkjetGatewayAccountHealth } from "@workjet/contracts";
import { WorkjetGatewayAccountId } from "@workjet/contracts";
import { modelsAccountHealth } from "./WorkjetModelsHealth";

const account: WorkjetGatewayAccountHealth = {
  accountId: WorkjetGatewayAccountId.make("fixture-account"),
  provider: "codex",
  authentication: "unknown",
  disabled: false,
  usable: true,
  cooldownUntilMs: null,
  errorCode: null,
  httpStatus: null,
  generationHttpStatus: null,
  observedAtMs: null,
  quota: [],
  quotaSupported: true,
  quotaRefreshing: false,
  quotaError: null,
};

describe("Models account recovery", () => {
  it.each([401, 403, 429])("does not offer re-login for a usage-only %s", (httpStatus) => {
    expect(modelsAccountHealth({ ...account, httpStatus, quotaError: "provider-error" }, 1000).status).toBe("unknown");
  });

  it("shows rejected generation authentication, but keeps disabled accounts disabled", () => {
    const rejected = { ...account, authentication: "rejected" as const, generationHttpStatus: 401, usable: false };
    expect(modelsAccountHealth(rejected, 1000).status).toBe("auth-required");
    expect(modelsAccountHealth({ ...rejected, disabled: true }, 1000).status).toBe("disabled");
  });

  it("keeps exhausted quota blocked until the known reset, then shows remaining quota as unknown", () => {
    const exhausted = { ...account, quota: [{ name: "primary_window", remainingPercent: 0, resetsAtMs: 1_000_000, observedAtMs: 1000 }] };
    const health = modelsAccountHealth(exhausted, 400_000);
    expect(health.status).toBe("cooldown");
    expect(health.windows[0]?.remainingPercent).toBe(0);
    expect(health.retryAtMs).toBe(1_000_000);
    expect(modelsAccountHealth(exhausted, 1_000_000).windows[0]?.remainingPercent).toBeNull();
    expect(modelsAccountHealth(exhausted, 1_000_000).status).toBe("unknown");
  });

  it("never presents a stale positive reading or a passed cooldown as current exhaustion", () => {
    const stale = { ...account, generationHttpStatus: 429, cooldownUntilMs: 2000, quota: [{ name: "primary_window", remainingPercent: 65, resetsAtMs: 1_000_000, observedAtMs: 1000 }] };
    const health = modelsAccountHealth(stale, 400_000);
    expect(health.status).toBe("unknown");
    expect(health.windows[0]?.remainingPercent).toBeNull();
  });

  it("does not mark the whole account exhausted for an Opus-only window", () => {
    expect(modelsAccountHealth({ ...account, quota: [{ name: "seven_day_opus", remainingPercent: 0, resetsAtMs: 5000, observedAtMs: 1000 }] }, 2000).status).toBe("unknown");
  });
});
