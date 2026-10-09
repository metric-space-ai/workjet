import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  WorkjetNativeProviderAccount,
  WorkjetNativeProviderRequest,
  WorkjetNativeProviderRegistry,
} from "./workjetNativeProviders.ts";

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
  it("retains catalog evidence without promoting it to inference verification", () => {
    const registry = Schema.decodeUnknownSync(WorkjetNativeProviderRegistry)({
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
      Schema.decodeUnknownSync(WorkjetNativeProviderAccount)({
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
      expect(() => Schema.decodeUnknownSync(WorkjetNativeProviderAccount)(value)).toThrow();
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
    expect(Schema.decodeUnknownSync(WorkjetNativeProviderRequest)(base)).toEqual(base);
    for (const invalid of [
      { ...base, expectedAccountRevision: 0 },
      { ...base, expectedRevision: -1 },
      { ...base, models: Array.from({ length: 257 }, () => "claude-opus-5-5") },
      { ...base, action: "instance.providers.secret" },
    ])
      expect(() => Schema.decodeUnknownSync(WorkjetNativeProviderRequest)(invalid)).toThrow();
  });
});
