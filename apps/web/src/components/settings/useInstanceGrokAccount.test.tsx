import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { useInstanceGrokAccount } from "./useInstanceGrokAccount";

function AccountRow() {
  return useInstanceGrokAccount("managed:welsch", "Welsch").row;
}

describe("Unloaded instance Grok account", () => {
  it("shows unknown status before any instance reply without claiming the subscription is absent", () => {
    const rendered = renderToStaticMarkup(<AccountRow />);
    expect(rendered).toContain("Not loaded");
    expect(rendered).toContain('aria-label="Account status unavailable"');
    expect(rendered).toContain("Account status unavailable. Refresh to retry.");
    expect(rendered).not.toContain("No subscription stored.");
    expect(rendered).not.toContain("Subscription stored on this CTOX instance.");
    expect(rendered).toContain('aria-label="Refresh Grok account"');
  });
});
