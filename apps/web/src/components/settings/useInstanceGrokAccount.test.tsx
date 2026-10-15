import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { useInstanceGrokAccount } from "./useInstanceGrokAccount";

function AccountRow() {
  return useInstanceGrokAccount("managed:welsch", "Welsch").row;
}

describe("Unloaded instance Grok account", () => {
  it("shows unknown status before any instance reply without claiming the subscription is absent", () => {
    const rendered = renderToStaticMarkup(<AccountRow />);
    expect(rendered).toContain("Welsch · —");
    expect(rendered).not.toContain("Nicht geladen");
    expect(rendered).toContain('aria-label="Kontostatus nicht verfügbar"');
    expect(rendered).toContain('title="Kontostatus nicht verfügbar"');
    expect(rendered).not.toContain("Kein Abo gespeichert");
    expect(rendered).not.toContain("Abo gespeichert");
    expect(rendered).toContain('aria-label="Grok-Konto neu laden"');
  });
});
