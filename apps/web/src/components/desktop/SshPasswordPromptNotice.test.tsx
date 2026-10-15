import type { DesktopSshPasswordPromptRequest } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ActiveSshPasswordPrompt } from "./SshPasswordPromptNotice";

const request = {
  requestId: "ssh-1",
  destination: "100.87.204.48",
  username: "deck",
  prompt: "deck@100.87.204.48's password:",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
} as DesktopSshPasswordPromptRequest;

describe("SSH password prompt", () => {
  it("is an inline secure field under the header, not a dialog", () => {
    const markup = renderToStaticMarkup(
      <ActiveSshPasswordPrompt request={request} onRemove={() => undefined} />,
    );
    expect(markup).toContain("data-ssh-password-prompt");
    expect(markup).toContain('type="password"');
    expect(markup).toMatch(/autocomplete="current-password"/i);
    expect(markup).toContain("deck@100.87.204.48");
    expect(markup).toMatch(/data-ssh-password-submit[^>]*>Verbinden</);
    expect(markup).toMatch(/data-ssh-password-cancel[^>]*>Abbrechen</);
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("aria-modal");
    // Kein englischer Erklärsatz mehr, kein Passwort im Markup.
    expect(markup).not.toContain("not saved by Workjet");
    expect(markup).not.toMatch(/value="[^"]+"/);
  });

  it("shows the expiry as one status line", () => {
    const expired = { ...request, expiresAt: new Date(Date.now() - 1_000).toISOString() };
    const markup = renderToStaticMarkup(
      <ActiveSshPasswordPrompt request={expired} onRemove={() => undefined} />,
    );
    expect(markup).toContain("Abgelaufen, bitte neu verbinden");
    expect(markup).toMatch(/data-ssh-password-cancel[^>]*>Schließen</);
  });
});
