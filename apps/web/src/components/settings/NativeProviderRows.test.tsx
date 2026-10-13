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
  return registryHtml(
    { ...registry, accounts: [account] },
    busy,
    error,
    error ? accountId : undefined,
  );
}
function registryHtml(
  current: WorkjetNativeProviderRegistry,
  busy = false,
  error?: string,
  errorAccountId?: string,
) {
  vi.mocked(useInstanceProviders).mockReturnValue({
    registry: current,
    error,
    errorAccountId,
    busy,
    run: vi.fn(async (): Promise<WorkjetNativeProviderRegistry | undefined> => undefined),
    check: vi.fn(async () => undefined),
    refresh: vi.fn(async (): Promise<WorkjetNativeProviderRegistry | undefined> => undefined),
  });
  return renderToStaticMarkup(<NativeProviderRows instanceId="managed:welsch" label="Welsch" />);
}
describe("Native provider account rows", () => {
  const apiAccount: WorkjetNativeProviderAccount = {
    ...registry.accounts[0]!,
    id: "native-api-fixture",
    provider: "zai",
    controls: { canEnable: false, canRemove: false },
    nativeAccountReference: {
      accountId: "native-api-fixture",
      holderInstanceId,
      accountRevision: 3,
    },
    modelCatalog: { ...registry.accounts[0]!.modelCatalog, models: ["glm-5.3-flash"] },
    effectiveModels: ["glm-5.3-flash"],
  };
  const apiSelection = { provider: "zai", selection: ["glm-5.3-flash"] };

  it("shows a real non-Claude account with its own shared live models and holder controls", () => {
    const rendered = registryHtml({
      ...registry,
      providers: [apiSelection],
      accounts: [apiAccount],
    });
    expect(rendered).toContain("Z.ai (GLM) · Welsch");
    expect(rendered).toContain("glm-5.3-flash");
    expect(rendered).toContain('aria-label="Modelle für zai"');
    expect(rendered).not.toContain("OAuth");
    expect(rendered).not.toContain('role="switch"');
    expect(control(rendered, "glm-5.3-flash prüfen")).toContain("disabled");
    expect(rendered).toContain("Prüfung nicht verfügbar");
    expect(rendered).not.toContain("Prüfung bestanden");
    expect(control(rendered, "Konto 1 entfernen")).toContain("disabled");
    expect(rendered).toContain("Entfernen nicht möglich");
    // The raw account id stays in non-visible automation hooks only.
    expect(rendered).not.toMatch(/>[^<]*native-api-fixture/);
    expect(rendered).not.toContain("CTOX aktualisieren");
  });
  it("keeps provider model fields separate and shows a shared refresh failure once", () => {
    const rendered = registryHtml(
      {
        ...registry,
        accounts: [registry.accounts[0]!, apiAccount],
        providers: [...registry.providers, apiSelection],
      },
      false,
      "The instance refresh failed.",
    );
    expect(rendered).toContain('aria-label="Modelle für claude"');
    expect(rendered).toContain('aria-label="Modelle für zai"');
    expect(rendered).toContain("claude-opus-5-5");
    expect(rendered).toContain("glm-5.3-flash");
    expect(rendered.match(/role="alert"/g)).toHaveLength(1);
    expect(rendered).toContain("The instance refresh failed.");
  });
  it("retains an unfamiliar native provider using its real public identity", () => {
    const account = { ...apiAccount, provider: "ctox_proxy" };
    const rendered = registryHtml({
      ...registry,
      accounts: [account],
      providers: [{ ...apiSelection, provider: "ctox_proxy" }],
    });
    expect(rendered).toContain("ctox_proxy · Welsch");
    expect(rendered).toContain('aria-label="Modelle für ctox_proxy"');
    expect(rendered).toContain("glm-5.3-flash");
  });

  it("shows an actual green Hi status and measured latency instead of a catalog-derived claim", () => {
    const rendered = html({
      ...registry.accounts[0]!,
      modelChecks: [
        {
          modelId: "claude-opus-5-5",
          checkedAtMs: 1000,
          elapsedMs: 123,
          status: "ok",
          source: "upstream",
          failure: null,
          httpStatus: 200,
          retryAtMs: null,
        },
      ],
    });
    expect(rendered).toContain("Prüfung bestanden");
    expect(rendered).toContain("123 ms");
    expect(rendered).toContain("Alle prüfen");
    expect(rendered).not.toContain("Nicht geprüft");
  });
  it("shows real model failure with a fix and local cooldown as a separate unavailable state", () => {
    const base = {
      modelId: "claude-opus-5-5",
      checkedAtMs: 1000,
      elapsedMs: 123,
      httpStatus: 404,
      retryAtMs: null,
    } as const;
    const red = html({
      ...registry.accounts[0]!,
      modelChecks: [{ ...base, status: "failed", source: "upstream", failure: "model_not_found" }],
    });
    expect(red).toContain("Prüfung fehlgeschlagen: model_not_found");
    expect(red).toContain("Modellliste neu laden");
    const local = html({
      ...registry.accounts[0]!,
      modelChecks: [
        {
          ...base,
          status: "unavailable",
          source: "gateway",
          failure: "gateway_cooldown",
          httpStatus: 503,
          retryAtMs: 2000,
        },
      ],
    });
    expect(local).toContain("Prüfung nicht verfügbar: gateway_cooldown");
    expect(local).toContain("Neuversuch ab");
    expect(local).not.toContain("Prüfung fehlgeschlagen");
    expect(local).not.toContain("Credentials rejected");
  });

  it.each([undefined, "guest_failed"])(
    "does not claim an empty account list before a successful read (error: %s)",
    (error) => {
      vi.mocked(useInstanceProviders).mockReturnValue({
        registry: undefined,
        error,
        errorAccountId: undefined,
        busy: !error,
        run: vi.fn(async () => undefined),
        check: vi.fn(async () => undefined),
        refresh: vi.fn(async () => undefined),
      });
      const rendered = renderToStaticMarkup(
        <NativeProviderRows instanceId="managed:welsch" label="Welsch" />,
      );
      expect(rendered).toContain("Konten nicht geladen");
      expect(rendered).not.toContain("0 Konten");
      if (error) expect(rendered).toContain(error);
    },
  );
  it("shows zero accounts only after an actual empty registry reply", () => {
    vi.mocked(useInstanceProviders).mockReturnValue({
      registry: { ...registry, accounts: [] },
      error: undefined,
      errorAccountId: undefined,
      busy: false,
      run: vi.fn(async () => undefined),
      check: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
    });
    const rendered = renderToStaticMarkup(
      <NativeProviderRows instanceId="managed:welsch" label="Welsch" />,
    );
    expect(rendered).toContain("0 Konten");
    expect(rendered).not.toContain("Konten nicht geladen");
  });
  it("keeps previously observed accounts visible when refreshing fails", () => {
    const rendered = html(registry.accounts[0]!, false, "guest_failed");
    expect(rendered).toContain("1 Konten");
    expect(rendered).toContain("Konto 1");
    expect(rendered).not.toMatch(new RegExp(`>[^<]*${accountId.slice(0, 8)}`));
    expect(rendered).not.toContain("Konten nicht geladen");
  });
  it("places the account toggle and permanent removal beside the full model name", () => {
    const rendered = html();
    expect(rendered).toContain('role="switch"');
    expect(rendered).toContain(`aria-label="Konto 1 aktiv"`);
    expect(rendered).toContain(`aria-label="Konto 1 entfernen"`);
    expect(rendered).toContain("claude-opus-5-5");
    expect(rendered).toContain("Nicht geprüft");
    expect(rendered).not.toContain("Inference verified");
    expect(rendered).not.toContain("Entfernen</button>");
  });
  it("does not offer a writable toggle or enabled trash action from an older holder", () => {
    const { controls: _controls, ...older } = registry.accounts[0]!;
    const rendered = html(older);
    expect(rendered).not.toContain('role="switch"');
    expect(rendered).toContain("CTOX aktualisieren");
    expect(control(rendered, "Konto 1 entfernen")).toContain("disabled");
  });
  it("keeps a failed account visible and disables duplicate mutations while awaiting the holder", () => {
    const rendered = html(
      registry.accounts[0]!,
      true,
      "The instance has not confirmed this account change. Refresh accounts before trying again.",
    );
    expect(rendered).toContain('role="alert"');
    expect(rendered).toContain("has not confirmed this account change");
    expect(rendered).toContain("Konto 1");
    expect(rendered).not.toMatch(new RegExp(`>[^<]*${accountId.slice(0, 8)}`));
    expect(control(rendered, "Konto 1 aktiv")).toContain("disabled");
    expect(control(rendered, "Konto 1 entfernen")).toContain("disabled");
  });
  it("renders the actual disabled state without claiming a credential or inference failure", () => {
    const rendered = html({ ...registry.accounts[0]!, enabled: false });
    expect(rendered).toContain("Konto aktivieren");
    expect(control(rendered, "Konto 1 aktiv")).not.toContain("checked");
    expect(rendered).not.toContain("Keine Limits gemeldet");
    expect(rendered).not.toContain("Credentials rejected");
  });
});
