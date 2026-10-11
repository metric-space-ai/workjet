import type { WorkjetNativeModelProbe, WorkjetNativeProviderRegistry } from "@workjet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
const api = vi.hoisted(() => ({ request: vi.fn(), check: vi.fn() }));
vi.mock("../../lib/workjetNativeProviders", () => ({
  requestInstanceProviders: api.request,
  checkInstanceModel: api.check,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: <T,>(callback: T, deps: readonly unknown[]) => {
      const memo = reactHookHarness.useRef({ callback, deps });
      if (
        memo.current.deps.length !== deps.length ||
        memo.current.deps.some((dep, index) => !Object.is(dep, deps[index]))
      )
        memo.current = { callback, deps };
      return memo.current.callback;
    },
    useEffect: reactHookHarness.useEffect,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
import { useInstanceProviders } from "./useInstanceProviders";
const model = "claude-opus-5-5";
const accountId = "196a89ba-ee86-4413-885c-04ca60e6f291";
const holderId = "322084e5-8239-48d7-b3c5-c5178fbe5822";
const base: WorkjetNativeProviderRegistry = {
  ok: true,
  schema: "ctox.provider-federation-registry.v1",
  revision: 1,
  accounts: [
    {
      id: accountId,
      provider: "claude",
      holder: { kind: "ctox_instance", id: holderId },
      enabled: true,
      credentialReady: true,
      revision: 1,
      observedAtMs: 1,
      nativeAccountReference: { accountId, holderInstanceId: holderId, accountRevision: 1 },
      modelCatalogObserved: true,
      modelCatalog: {
        observed: true,
        fresh: true,
        models: [model],
        lastSuccessAtMs: 1,
        lastAttempt: {
          checkedAtMs: 1,
          httpStatus: 200,
          elapsedMs: 10,
          retryAfterSeconds: null,
          failure: null,
          success: true,
        },
      },
      excludedModels: [],
      effectiveModels: [model],
      inferenceVerified: false,
    },
  ],
  providers: [{ provider: "claude", selection: [model] }],
};
const reported: WorkjetNativeProviderRegistry = {
  ...base,
  accounts: [
    {
      ...base.accounts[0]!,
      reportedQuota: {
        state: "reported",
        observedAtMs: 1000,
        windows: [{ kind: "five_hour", status: "allowed", resetAtMs: 2000, utilization: 0.25 }],
      },
    },
  ],
};
const probe: WorkjetNativeModelProbe = {
  modelId: model,
  checkedAtMs: 1000,
  elapsedMs: 50,
  status: "ok",
  source: "upstream",
  httpStatus: 200,
  failure: null,
  retryAtMs: null,
};
function render(instanceId = "managed:welsch") {
  hooks.beginRender();
  return useInstanceProviders(instanceId);
}
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
beforeEach(() => {
  hooks.reset();
  api.request.mockReset().mockResolvedValue(base);
  api.check.mockReset().mockResolvedValue(probe);
});
afterEach(() => hooks.reset());
describe("reported limits refresh through instance control", () => {
  it("reads limits after a model check and retains the genuine bound probe", async () => {
    render();
    await settle();
    api.request.mockResolvedValueOnce(reported);
    expect(await render().check(accountId, 1, model)).toEqual(probe);
    const current = render().registry!.accounts[0]!;
    expect(current.reportedQuota).toEqual(reported.accounts[0]!.reportedQuota);
    expect(current.modelChecks).toEqual([probe]);
    expect(api.request.mock.lastCall?.slice(0, 2)).toEqual([
      "managed:welsch",
      { action: "instance.providers.read" },
    ]);
  });
  it("keeps a successful model check when the separate limits read fails", async () => {
    render();
    await settle();
    api.request.mockRejectedValueOnce(new Error("channel unavailable"));
    expect(await render().check(accountId, 1, model)).toEqual(probe);
    expect(render().registry!.accounts[0]!).toMatchObject({
      reportedQuota: { state: "unavailable", errorClass: "quota_read_failed" },
      modelChecks: [probe],
    });
    expect(render().error).toBeUndefined();
  });
  it("drops old checks when the fresh registry has a replacement account generation", async () => {
    render();
    await settle();
    const replaced: WorkjetNativeProviderRegistry = {
      ...reported,
      revision: 2,
      accounts: [
        {
          ...reported.accounts[0]!,
          revision: 2,
          nativeAccountReference: { accountId, holderInstanceId: holderId, accountRevision: 2 },
        },
      ],
    };
    api.request.mockResolvedValueOnce(replaced);
    await render().check(accountId, 1, model);
    expect(render().registry!.accounts[0]!.revision).toBe(2);
    expect(render().registry!.accounts[0]!.modelChecks).toBeUndefined();
    expect(render().registry!.accounts[0]!.reportedQuota).toEqual(
      replaced.accounts[0]!.reportedQuota,
    );
  });
  it("reads the quota receipt after refresh/adoption instead of leaving limits blank", async () => {
    render();
    await settle();
    api.request.mockResolvedValueOnce(base).mockResolvedValueOnce(reported);
    const result = await render().refresh();
    expect(result?.accounts[0]!.reportedQuota).toEqual(reported.accounts[0]!.reportedQuota);
    expect(api.request.mock.calls.slice(-2).map((call) => call[1])).toEqual([
      { action: "instance.providers.adopt" },
      { action: "instance.providers.read" },
    ]);
  });
  it("does not publish a late limits receipt after switching instances", async () => {
    render();
    await settle();
    const pending = deferred<WorkjetNativeProviderRegistry>();
    api.request.mockReturnValueOnce(pending.promise);
    const checking = render().check(accountId, 1, model);
    await settle();
    render("managed:other");
    await settle();
    pending.resolve(reported);
    await checking;
    const current = render("managed:other");
    expect(current.registry!.accounts[0]!.reportedQuota).toEqual({ state: "unknown" });
    expect(current.registry!.accounts[0]!.modelChecks).toBeUndefined();
  });
});
