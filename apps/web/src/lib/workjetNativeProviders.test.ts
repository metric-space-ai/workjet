import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  WorkjetGatewayAccountId,
  WorkjetLlmRouteId,
  WorkjetNativeProviderRegistry,
} from "@workjet/contracts";
import type { WorkjetProjectControlPort } from "../workjetProjectControl";
import {
  nativeAccountForRoute,
  nativeLumaRoutes,
  requestInstanceProviders,
  requireNativeLumaModel,
} from "./workjetNativeProviders";
import { newCommandId } from "./utils";

const reference = {
  accountId: "196a89ba-ee86-4413-885c-04ca60e6f291",
  holderInstanceId: "322084e5-8239-48d7-b3c5-c5178fbe5822",
  accountRevision: 3,
};
const registry = Schema.decodeUnknownSync(WorkjetNativeProviderRegistry)({
  ok: true,
  schema: "ctox.provider-federation-registry.v1",
  revision: 0,
  accounts: [
    {
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
    },
  ],
  providers: [{ provider: "claude", selection: ["claude-opus-5-5"] }],
});
const account = registry.accounts[0]!;
describe("native account Luma composition", () => {
  it("preserves the typed instance preparation failure through the account consumer", async () => {
    const failure = {
      _tag: "failed",
      code: "guest_failed",
      preparation: { stage: "session", reason: "exception" },
    } as const;
    const port = vi.fn<WorkjetProjectControlPort>().mockResolvedValue(failure);
    await expect(
      requestInstanceProviders(
        "managed:welsch",
        { action: "instance.providers.read" },
        new AbortController().signal,
        port,
      ),
    ).rejects.toMatchObject({ failure });
  });

  afterEach(() => vi.useRealTimers());
  it("accepts account mutations only after a newer correlated registry confirms the change", async () => {
    const enable = {
      action: "instance.providers.account.enable",
      accountId: account.id,
      expectedAccountRevision: account.revision,
      expectedRevision: registry.revision,
      enabled: false,
    } as const;
    const remove = {
      action: "instance.providers.account.remove",
      accountId: account.id,
      expectedAccountRevision: account.revision,
      expectedRevision: registry.revision,
    } as const;
    const changed = {
      ...registry,
      revision: 1,
      accounts: [
        {
          ...account,
          enabled: false,
          revision: 4,
          nativeAccountReference: { ...reference, accountRevision: 4 },
        },
      ],
    };
    const respond = (snapshot: typeof registry) =>
      vi.fn<WorkjetProjectControlPort>(async (_instance, input) => {
        if (
          input.action !== "instance.providers.account.enable" &&
          input.action !== "instance.providers.account.remove"
        )
          throw new Error("Unexpected action");
        return {
          _tag: "completed",
          response: {
            version: 1,
            action: input.action,
            operationId: input.operationId,
            registry: snapshot,
          },
        };
      });
    expect(
      await requestInstanceProviders(
        "managed:welsch",
        enable,
        new AbortController().signal,
        respond(changed),
      ),
    ).toEqual(changed);
    const removed = { ...registry, revision: 1, accounts: [] };
    expect(
      await requestInstanceProviders(
        "managed:welsch",
        remove,
        new AbortController().signal,
        respond(removed),
      ),
    ).toEqual(removed);
    for (const snapshot of [
      registry,
      { ...changed, revision: 0 },
      { ...changed, accounts: [account] },
      { ...changed, accounts: [] },
    ])
      await expect(
        requestInstanceProviders(
          "managed:welsch",
          enable,
          new AbortController().signal,
          respond(snapshot),
        ),
      ).rejects.toThrow("has not confirmed this account change");
    await expect(
      requestInstanceProviders(
        "managed:welsch",
        remove,
        new AbortController().signal,
        respond(changed),
      ),
    ).rejects.toThrow("has not confirmed this account change");
  });

  it("adds native-only routes without substituting local gateway authority", () => {
    const legacy = {
      id: WorkjetLlmRouteId.make("legacy"),
      label: "Source account",
      gatewayAccountId: WorkjetGatewayAccountId.make("local-account"),
    };
    const routes = nativeLumaRoutes([legacy], registry, "Welsch");
    expect(routes[0]).toBe(legacy);
    expect(routes[1]).toEqual(expect.objectContaining({ nativeAccountReference: reference }));
    expect(routes[1]).not.toHaveProperty("gatewayAccountId");
    const native = {
      ...routes[1]!,
      id: WorkjetLlmRouteId.make("saved-native"),
      label: "My Luma account",
    };
    const updated = {
      ...registry,
      accounts: [
        { ...account, revision: 4, nativeAccountReference: { ...reference, accountRevision: 4 } },
      ],
    };
    expect(nativeLumaRoutes([legacy, native], updated, "Welsch")[1]).toEqual({
      ...native,
      nativeAccountReference: { ...reference, accountRevision: 4 },
    });
    expect(nativeAccountForRoute(native, updated.accounts)).toBeUndefined();
  });
  it("allows only enabled, configured, fresh and selected account models", () => {
    expect(() => requireNativeLumaModel(account, "claude-opus-5-5")).not.toThrow();
    for (const invalid of [
      undefined,
      { ...account, enabled: false },
      { ...account, credentialReady: false },
      { ...account, modelCatalog: { ...account.modelCatalog, fresh: false } },
      { ...account, effectiveModels: [] },
    ])
      expect(() => requireNativeLumaModel(invalid, "claude-opus-5-5")).toThrow();
    expect(() => requireNativeLumaModel(account, "claude-sonnet-5-5")).toThrow();
  });
  it("addresses the chosen instance and accepts only its correlated public receipt", async () => {
    const port = vi.fn<WorkjetProjectControlPort>(async (_instance, input) => {
      if (input.action !== "instance.providers.read") throw new Error("Unexpected request");
      return {
        _tag: "completed",
        response: { version: 1, action: input.action, operationId: input.operationId, registry },
      };
    });
    expect(
      await requestInstanceProviders(
        "managed:welsch",
        { action: "instance.providers.read" },
        new AbortController().signal,
        port,
      ),
    ).toEqual(registry);
    expect(port).toHaveBeenCalledWith("managed:welsch", expect.objectContaining({ version: 1 }));
    const foreign = vi.fn<WorkjetProjectControlPort>(async (_instance, input) => {
      if (input.action !== "instance.providers.read") throw new Error("Unexpected request");
      return {
        _tag: "completed",
        response: { version: 1, action: input.action, operationId: newCommandId(), registry },
      };
    });
    await expect(
      requestInstanceProviders(
        "managed:welsch",
        { action: "instance.providers.read" },
        new AbortController().signal,
        foreign,
      ),
    ).rejects.toThrow("another request");
  });
  it("bounds stalled transport and retires a pending instance scope", async () => {
    vi.useFakeTimers();
    const port = vi.fn<WorkjetProjectControlPort>(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = requestInstanceProviders(
      "managed:welsch",
      { action: "instance.providers.read" },
      controller.signal,
      port,
    );
    const cancelled = expect(pending).rejects.toThrow("Cancelled");
    controller.abort();
    await cancelled;
    const hung = requestInstanceProviders(
      "managed:welsch",
      { action: "instance.providers.read" },
      new AbortController().signal,
      port,
    );
    const bounded = expect(hung).rejects.toThrow("did not respond in time");
    await vi.advanceTimersByTimeAsync(30_000);
    await bounded;
  });
  it("sanitizes unknown transport failures instead of echoing credential material", async () => {
    const port = vi.fn<WorkjetProjectControlPort>(async () => {
      throw new Error("private-fixture");
    });
    await expect(
      requestInstanceProviders(
        "managed:welsch",
        { action: "instance.providers.read" },
        new AbortController().signal,
        port,
      ),
    ).rejects.toThrow("Instance account control is unavailable.");
  });
});
