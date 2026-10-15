import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { InstanceProviderSection } from "./InstanceProviderSection";
import type { useInstanceProviders } from "./useInstanceProviders";
import type { InstanceGrokAccountPresentation } from "./WorkjetModelsProviders";
import type { WorkjetProjectControlFailure } from "../../workjetProjectControl";

function renderSection(
  providerFailure?: WorkjetProjectControlFailure,
  grokFailure?: WorkjetProjectControlFailure,
  providerError?: string,
) {
  const providers: ReturnType<typeof useInstanceProviders> = {
    registry: undefined,
    error: providerError,
    errorAccountId: undefined,
    ...(providerFailure ? { connectionFailure: providerFailure } : {}),
    busy: false,
    run: vi.fn(async () => undefined),
    check: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  };
  const grok: InstanceGrokAccountPresentation = {
    row: <button data-grok-login="">Grok Build OAuth</button>,
    label: "Welsch",
    installed: false,
    hasModels: false,
    checking: false,
    connectionFailure: grokFailure,
    start: vi.fn(async () => null),
    checkAll: vi.fn(),
    refresh: vi.fn(),
  };
  return renderToStaticMarkup(
    <InstanceProviderSection label="Welsch" grok={grok} providers={providers} />,
  );
}

describe("independent instance account capabilities", () => {
  it("keeps the admitted Grok login visible when general account management is unsupported", () => {
    const html = renderSection({ _tag: "failed", code: "unsupported" });
    expect(html).toContain("data-grok-login");
    expect(html).toContain("data-workjet-provider-management-unavailable");
    expect(html).toContain("Business-OS-Shell aktualisieren");
    expect(html).not.toContain("data-workjet-instance-connection");
    expect(html).not.toContain("Instanz Welsch nicht verbunden");
  });

  it("still blocks the Grok row when its own admitted channel requires authentication", () => {
    const html = renderSection(
      { _tag: "failed", code: "unsupported" },
      { _tag: "failed", code: "authentication_required" },
    );
    expect(html).not.toContain("data-grok-login");
    expect(html).toContain("data-workjet-instance-connection");
    expect(html).toContain("Bei der Instanz anmelden, um sie zu verbinden");
  });

  it("retries transport failures silently and keeps the known rows without a status line", () => {
    for (const html of [
      renderSection({ _tag: "failed", code: "timeout" }),
      renderSection({ _tag: "failed", code: "guest_failed" }, { _tag: "failed", code: "guest_failed" }),
      renderSection(undefined, undefined, "Account metadata unavailable"),
    ]) {
      expect(html).toContain("data-grok-login");
      expect(html).not.toContain("data-workjet-instance-connection");
      expect(html).not.toContain("nicht erreichbar");
      expect(html).not.toContain("guest_failed");
      expect(html).not.toContain("Account metadata unavailable");
      expect(html).not.toContain("data-workjet-provider-management-unavailable");
    }
  });
});
