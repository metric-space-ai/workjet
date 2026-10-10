import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  WorkjetNativeProviderAccount,
  WorkjetNativeProviderRequest,
  WorkjetNativeProviderRegistry,
} from "./workjetNativeProviders.ts";

const decodeRegistry = Schema.decodeUnknownSync(WorkjetNativeProviderRegistry);
const decodeAccount = Schema.decodeUnknownSync(WorkjetNativeProviderAccount);
const decodeRequest = Schema.decodeUnknownSync(WorkjetNativeProviderRequest);

const reference = {
  accountId: "196a89ba-ee86-4413-885c-04ca60e6f291",
  holderInstanceId: "322084e5-8239-48d7-b3c5-c5178fbe5822",
  accountRevision: 3,
};
const account = {
  id: reference.accountId,
  holder: { kind: "ctox_instance", id: reference.holderInstanceId },
  provider: "claude",
  enabled: true,
  credentialReady: true,
  revision: 3,
  observedAtMs: 1,
  nativeAccountReference: reference,
  modelCatalogObserved: true,
  modelCatalog: {
    observed: true,
    fresh: true,
    models: ["claude-opus-5-5"],
    lastSuccessAtMs: 1,
    lastAttempt: {
      checkedAtMs: 1,
      httpStatus: 200,
      elapsedMs: 100,
      retryAfterSeconds: null,
      failure: null,
      success: true,
    },
  },
  excludedModels: [],
  effectiveModels: ["claude-opus-5-5"],
  inferenceVerified: false,
};
describe("native provider public contract", () => {
  it("decodes holder capabilities explicitly and keeps older registries read-only", () => {
    expect(decodeAccount(account).controls).toBeUndefined();
    expect(
      decodeAccount({ ...account, controls: { canEnable: true, canRemove: false } }).controls,
    ).toEqual({ canEnable: true, canRemove: false });
    expect(() =>
      decodeAccount({ ...account, controls: { canEnable: "yes", canRemove: true } }),
    ).toThrow();
    expect(() => decodeAccount({ ...account, controls: { canEnable: true } })).toThrow();
  });
  it("requires both current revisions and a boolean for account lifecycle mutations", () => {
    const base = {
      version: 1,
      operationId: reference.accountId,
      accountId: reference.accountId,
      expectedAccountRevision: 3,
      expectedRevision: 7,
    };
    const enable = { ...base, action: "instance.providers.account.enable", enabled: false };
    const remove = { ...base, action: "instance.providers.account.remove" };
    expect(decodeRequest(enable)).toEqual(enable);
    expect(decodeRequest(remove)).toEqual(remove);
    for (const invalid of [
      { ...enable, enabled: undefined },
      { ...enable, enabled: "false" },
      { ...enable, expectedAccountRevision: 0 },
      { ...remove, expectedRevision: undefined },
      { ...remove, expectedRevision: -1 },
    ])
      expect(() => decodeRequest(invalid)).toThrow();
  });

  it("retains catalog evidence without promoting it to inference verification", () => {
    const registry = decodeRegistry({
      ok: true,
      schema: "ctox.provider-federation-registry.v1",
      revision: 0,
      accounts: [{ ...account, accessToken: "private-fixture" }],
      providers: [{ provider: "claude", selection: ["claude-opus-5-5"] }],
    });
    expect(registry.accounts[0]?.modelCatalog.models).toEqual(["claude-opus-5-5"]);
    expect(registry.accounts[0]?.inferenceVerified).toBe(false);
    expect(JSON.stringify(registry)).not.toContain("private-fixture");
    expect(() =>
      decodeAccount({
        ...account,
        inferenceVerified: true,
      }),
    ).toThrow();
  });
  it("rejects mismatched holding identity, revision and fabricated fresh evidence", () => {
    for (const value of [
      { ...account, nativeAccountReference: { ...reference, accountRevision: 4 } },
      { ...account, holder: { ...account.holder, id: "foreign-holder" } },
      { ...account, modelCatalogObserved: false },
      { ...account, modelCatalog: { ...account.modelCatalog, lastAttempt: null } },
      { ...account, modelCatalog: { ...account.modelCatalog, lastSuccessAtMs: null } },
    ])
      expect(() => decodeAccount(value)).toThrow();
  });
  it("requires native account and policy revisions for mutation commands", () => {
    const base = {
      version: 1,
      operationId: reference.accountId,
      action: "instance.providers.models.exclude",
      accountId: reference.accountId,
      expectedAccountRevision: 3,
      models: [],
      expectedRevision: 0,
    };
    expect(decodeRequest(base)).toEqual(base);
    for (const invalid of [
      { ...base, expectedAccountRevision: 0 },
      { ...base, expectedRevision: -1 },
      { ...base, models: Array.from({ length: 257 }, () => "claude-opus-5-5") },
      { ...base, action: "instance.providers.secret" },
    ])
      expect(() => decodeRequest(invalid)).toThrow();
  });
});
