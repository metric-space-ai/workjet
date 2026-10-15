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
  balance: null,
  quotaSupported: true,
  quotaRefreshing: true,
  quotaError: null,
};
const status = (accounts: unknown) => ({
  account_health: { schema: "workjet.provider-gateway.account-health.v1", accounts },
});
describe("gateway account health", () => {
  it("preserves whitelisted raw quota evidence while accepting older hosts", () => {
    const source = { field: "percentage", value: 42, windowSeconds: 604800, status: null };
    const quota = [
      {
        name: "TOKENS_LIMIT_1",
        source,
        remainingPercent: 58,
        resetsAtMs: null,
        observedAtMs: 1000,
      },
    ];
    expect(
      decodeAccountHealth(status([{ ...account, provider: "zai", quota }]))?.[0]?.quota[0]?.source,
    ).toEqual(source);
    for (const patch of [
      { field: "guessed" },
      { value: 101 },
      { value: -1 },
      { windowSeconds: -1 },
    ]) {
      expect(
        decodeAccountHealth(
          status([{ ...account, quota: [{ ...quota[0], source: { ...source, ...patch } }] }]),
        ),
      ).toBeUndefined();
    }
  });
  it("defaults older hosts to unknown balance and validates monetary readings", () => {
    const { balance: omitted, ...older } = account;
    expect(omitted).toBeNull();
    expect(decodeAccountHealth(status([older]))?.[0]?.balance).toBeNull();
    const balance = {
      availableBalance: -1,
      currency: "CNY",
      cashBalance: -1,
      voucherBalance: 0,
      observedAtMs: 1000,
    };
    expect(
      decodeAccountHealth(status([{ ...account, provider: "kimi", balance }]))?.[0]?.balance,
    ).toEqual(balance);
    for (const patch of [
      { currency: "unknown" },
      { availableBalance: Number.NaN },
      { availableBalance: Number.POSITIVE_INFINITY },
      { voucherBalance: -1 },
      { observedAtMs: -1 },
    ]) {
      expect(
        decodeAccountHealth(status([{ ...account, balance: { ...balance, ...patch } }])),
      ).toBeUndefined();
    }
  });

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
  it("preserves model-specific routing failures without treating the whole account as down", () => {
    const model = {
      modelId: "gpt-6.1-sol",
      status: "cooldown",
      usable: false,
      cooldownUntilMs: 2000,
      errorCode: "rate_limit",
      httpStatus: 429,
      observedAtMs: 1000,
    };
    expect(decodeAccountHealth(status([{ ...account, models: [model] }]))?.[0]?.models).toEqual([
      model,
    ]);
    const ready = decodeAccountHealth(
      status([{ ...account, models: [{ ...model, status: "ready" }] }]),
    );
    expect(ready?.[0]?.models?.[0]?.status).toBe("ready");
    expect(
      decodeAccountHealth(status([{ ...account, models: [{ ...model, status: "guess" }] }])),
    ).toBeUndefined();
  });
  it("rejects fabricated percentages, invalid timestamps and provider identities", () => {
    for (const patch of [
      { provider: "fake" },
      { observedAtMs: -1 },
      { quota: [{ name: "primary", remainingPercent: -1, resetsAtMs: null, observedAtMs: 1 }] },
    ]) {
      expect(decodeAccountHealth(status([{ ...account, ...patch }]))).toBeUndefined();
    }
  });
});
