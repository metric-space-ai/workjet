import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { grokFailureLine, useInstanceGrokAccount } from "./useInstanceGrokAccount";

function AccountRow() {
  return useInstanceGrokAccount("managed:welsch", "Welsch").row;
}

describe("Unloaded instance Grok account", () => {
  it("shows a quiet skeleton before any instance reply, never a placeholder sign", () => {
    const rendered = renderToStaticMarkup(<AccountRow />);
    expect(rendered).toContain('data-slot="settings-loading"');
    expect(rendered).not.toContain("—");
    expect(rendered).not.toContain("✓");
    expect(rendered).not.toContain("◌");
    expect(rendered).not.toContain("Kein Abo gespeichert");
    // Hinzugefügt wird nur über „+ Hinzufügen“ (Audit C 46): kein zweiter Weg.
    expect(rendered).not.toContain("Grok Build OAuth");
    expect(rendered).not.toContain("models.instance.xai.add-account");
  });
});

describe("Instance Grok failure lines", () => {
  it("stays German and at most twelve words", () => {
    for (const failure of [
      { errorCode: "timeout" as const, upstream: null },
      { errorCode: "request_failed" as const, upstream: null },
      { errorCode: null, upstream: { status: 401, stage: "inference" as const } },
      { errorCode: null, upstream: { status: 503, stage: "catalog" as const } },
    ]) {
      const line = grokFailureLine(failure);
      expect(line.split(/\s+/).length).toBeLessThanOrEqual(12);
      expect(line).not.toMatch(/\b(the|provider|retry)\b/i);
    }
  });
});
