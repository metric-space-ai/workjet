import * as Schema from "effect/Schema";
import type {
  WorkjetNativeProviderAccount,
  WorkjetNativeProviderRegistry,
} from "@workjet/contracts";
import { WorkjetNativeProviderRegistry as RegistrySchema } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { NativeProviderRows } from "./NativeProviderRows";
import { useInstanceProviders } from "./useInstanceProviders";

vi.mock("./useInstanceProviders", () => ({ useInstanceProviders: vi.fn() }));
const accountId = "196a89ba-ee86-4413-885c-04ca60e6f291";
const holderInstanceId = "322084e5-8239-48d7-b3c5-c5178fbe5822";
const registry = Schema.decodeUnknownSync(RegistrySchema)({
  ok: true,
  schema: "ctox.provider-federation-registry.v1",
  revision: 7,
  accounts: [
    {
      id: accountId,
      holder: { kind: "ctox_instance", id: holderInstanceId },
      provider: "claude",
      enabled: true,
      controls: { canEnable: true, canRemove: true },
      credentialReady: true,
      revision: 3,
      observedAtMs: 1,
      nativeAccountReference: { accountId, holderInstanceId, accountRevision: 3 },
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
function control(rendered: string, label: string) {
  return rendered
    .match(/<(?:input|button)\b[^>]*>/g)
    ?.find((tag) => tag.includes(`aria-label="${label}"`));
}
function html(
  account: WorkjetNativeProviderAccount = registry.accounts[0]!,
  busy = false,
  error?: string,
) {
  vi.mocked(useInstanceProviders).mockReturnValue({
    registry: { ...registry, accounts: [account] },
    error,
    errorAccountId: error ? accountId : undefined,
    busy,
    run: vi.fn(async (): Promise<WorkjetNativeProviderRegistry | undefined> => undefined),
    refresh: vi.fn(async (): Promise<WorkjetNativeProviderRegistry | undefined> => undefined),
  });
  return renderToStaticMarkup(<NativeProviderRows instanceId="managed:welsch" label="Welsch" />);
}
describe("Native provider account rows", () => {
  it("places the account toggle and permanent removal beside the full model name", () => {
    const rendered = html();
    expect(rendered).toContain('role="switch"');
    expect(rendered).toContain(`aria-label="Use instance account ${accountId}"`);
    expect(rendered).toContain(`aria-label="Permanently remove instance account ${accountId}"`);
    expect(rendered).toContain("claude-opus-5-5");
    expect(rendered).toContain("Inference not checked");
    expect(rendered).not.toContain("Inference verified");
    expect(rendered).not.toContain("Remove account</button>");
  });
  it("does not offer a writable toggle or enabled trash action from an older holder", () => {
    const { controls: _controls, ...older } = registry.accounts[0]!;
    const rendered = html(older);
    expect(rendered).not.toContain('role="switch"');
    expect(rendered).toContain("Update CTOX to remove this account here.");
    expect(control(rendered, `Permanently remove instance account ${accountId}`)).toContain(
      "disabled",
    );
  });
  it("keeps a failed account visible and disables duplicate mutations while awaiting the holder", () => {
    const rendered = html(
      registry.accounts[0]!,
      true,
      "The instance has not confirmed this account change. Refresh accounts before trying again.",
    );
    expect(rendered).toContain('role="alert"');
    expect(rendered).toContain("has not confirmed this account change");
    expect(rendered).toContain(`Account ${accountId.slice(0, 8)}`);
    expect(control(rendered, `Use instance account ${accountId}`)).toContain("disabled");
    expect(control(rendered, `Permanently remove instance account ${accountId}`)).toContain(
      "disabled",
    );
  });
  it("renders the actual disabled state without claiming a credential or inference failure", () => {
    const rendered = html({ ...registry.accounts[0]!, enabled: false });
    expect(rendered).toContain("Enable this CTOX account");
    expect(control(rendered, `Use instance account ${accountId}`)).not.toContain("checked");
    expect(rendered).toContain("has not reported limits");
    expect(rendered).not.toContain("Credentials rejected");
  });
});
