import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

function warningProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-23T12:00:00.000Z",
    message: "Provider is temporarily degraded.",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("ProviderStatusBanner", () => {
  it("stays hidden after its current warning is dismissed", () => {
    const status = warningProvider();

    expect(shouldShowProviderStatusBanner(status, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(status, getProviderStatusBannerKey(status))).toBe(false);
  });

  it("renders an accessible dismiss control for provider warnings", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}}
        onAction={() => {}} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Codex-Warnung schließen"');
  });

  it("renders on a glass surface so the timeline never reads through the banner", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}}
        onAction={() => {}} />,
    );

    expect(markup).toContain("alert-glass");
    expect(markup).toContain('data-variant="warning"');
  });

  it("labels error dismiss controls with the correct severity", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={{ ...warningProvider(), status: "error" }}
        onDismiss={() => {}}
        onAction={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Codex-Fehler schließen"');
  });

  it("shows a compact 'Harness fehlt' state instead of the raw PATH error", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={{
          ...warningProvider(),
          status: "error",
          installed: false,
          message: "Codex CLI (`codex`) is not installed or not on PATH.",
        }}
        onDismiss={() => {}}
        onAction={() => {}}
      />,
    );

    expect(markup).toContain("Codex nicht installiert");
    expect(markup).toContain("Einrichten");
    expect(markup).not.toContain("not on PATH");
    expect(markup).not.toContain("CLI");
  });

  it("keeps raw English provider text and HTTP status out of the banner", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={{
          ...warningProvider(),
          status: "error",
          message: "Failed to connect to the configured OpenCode server (HTTP 503).",
        }}
        onDismiss={() => {}}
        onAction={() => {}}
      />,
    );
    expect(markup).toContain("Codex nicht verfügbar</span>");
    expect(markup).not.toContain("<summary");
    expect(markup).not.toContain("HTTP 503");
  });
  it("offers sign-in in-app instead of the CLI for an unauthenticated harness", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={{ ...warningProvider(), status: "error", auth: { status: "unauthenticated" } }}
        onDismiss={() => {}}
        onAction={() => {}}
      />,
    );
    expect(markup).toContain("Codex nicht angemeldet");
    expect(markup).toContain("Anmelden");
    expect(markup).not.toContain("CLI");
  });
});
