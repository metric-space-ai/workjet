import { WorkjetGatewayAccountId, type WorkjetGatewayAccountSummary } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelCheckPass, remainingModelChecks } from "./WorkjetModelsChecks";
import type { ModelsModelCheck } from "./WorkjetModelsProviders";

const account: WorkjetGatewayAccountSummary = {
  id: WorkjetGatewayAccountId.make("account-a"),
  provider: "codex",
  label: "Work",
  enabled: true,
  priority: 0,
  weight: 1,
  modelIds: Array.from({ length: 100 }, (_, i) => `model-${i}`),
  credentialSuffix: null,
};
function observed(modelId: string, checkedAtMs: number, failed = false): ModelsModelCheck {
  return {
    accountId: account.id,
    modelId,
    checkedAtMs,
    status: failed ? "error" : "ok",
    errorClass: failed ? "unknown-model" : null,
    latencyMs: 15000,
    httpStatus: failed ? 404 : 200,
  };
}

describe("finite model check passes", () => {
  it("finishes a slow forced pass once per target even after the first observations age past five minutes", () => {
    const initial = account.modelIds.map((model) => observed(model, 1000));
    const pass = createModelCheckPass([account], initial, 2000, undefined, true);
    const results = new Map(initial.map((check) => [check.modelId, check]));
    for (let i = 0; i < account.modelIds.length; i++) {
      const model = account.modelIds[i]!;
      results.set(model, observed(model, 2000 + (i + 1) * 15000, i === 49));
      expect(remainingModelChecks(pass, [account], [...results.values()])).toBe(99 - i);
    }
    // Errors are completed checks too. Another five-minute window does not
    // add the old prefix back to a manual Check all operation.
    expect(remainingModelChecks(pass, [account], [...results.values()])).toBe(0);
  });
  it("automatically checks new, stale and clock-reversed observations, while respecting fresh results", () => {
    const subset = { ...account, modelIds: ["fresh", "stale", "new", "future"] };
    const initial = [
      observed("fresh", 999000),
      observed("stale", 500000),
      observed("future", 1001000),
    ];
    const pass = createModelCheckPass([subset], initial, 1000000);
    expect(remainingModelChecks(pass, [subset], initial)).toBe(3);
    expect(
      remainingModelChecks(
        pass,
        [subset],
        [
          ...initial,
          observed("new", 1000100),
          observed("stale", 1000200),
          observed("future", 1000300),
        ],
      ),
    ).toBe(0);
  });
  it("does not strand a pass when an account is disabled or a model is removed, and respects account scope", () => {
    const backup = {
      ...account,
      id: WorkjetGatewayAccountId.make("account-b"),
      modelIds: ["backup"],
    };
    const disabled = { ...account, id: WorkjetGatewayAccountId.make("disabled"), enabled: false };
    const pass = createModelCheckPass([account, backup, disabled], [], 1000, account.id, true);
    expect(remainingModelChecks(pass, [account, backup, disabled], [])).toBe(100);
    expect(
      remainingModelChecks(
        pass,
        [{ ...account, modelIds: account.modelIds.slice(0, 2) }, backup],
        [],
      ),
    ).toBe(2);
    expect(remainingModelChecks(pass, [{ ...account, enabled: false }, backup], [])).toBe(0);
  });
});
