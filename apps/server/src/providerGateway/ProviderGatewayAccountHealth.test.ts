import { describe, expect, it } from "vite-plus/test";
import { decodeAccountHealth } from "./ProviderGatewayManagement.ts";
const account = {
  accountId: "a",
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
  quotaRefreshing: true,
  quotaError: null,
};
const status = (accounts: unknown) => ({
  account_health: { schema: "workjet.provider-gateway.account-health.v1", accounts },
});
describe("gateway account health", () => {
  it("keeps an absent observation unknown and accepts genuine provider readings", () => {
    expect(decodeAccountHealth(status([account]))).toEqual([account]);
    expect(
      decodeAccountHealth(
        status([
          {
            ...account,
            authentication: "authenticated",
            observedAtMs: 1000,
            quota: [
              { name: "primary", remainingPercent: 42, resetsAtMs: 5000, observedAtMs: 1000 },
            ],
          },
        ]),
      )?.[0]?.quota[0]?.remainingPercent,
    ).toBe(42);
    expect(decodeAccountHealth({})).toBeUndefined();
  });
  it("rejects fabricated percentages, invalid timestamps and provider identities", () => {
    for (const patch of [
      { provider: "fake" },
      { observedAtMs: -1 },
      { quota: [{ name: "primary", remainingPercent: 101, resetsAtMs: null, observedAtMs: 1 }] },
    ]) {
      expect(decodeAccountHealth(status([{ ...account, ...patch }]))).toBeUndefined();
    }
  });
});
