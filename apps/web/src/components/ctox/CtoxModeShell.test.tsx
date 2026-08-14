import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CtoxMainShell } from "./CtoxModeShell";

describe("CtoxMainShell", () => {
  it("renders an honest empty state without a guest surface", () => {
    const markup = renderToStaticMarkup(<CtoxMainShell />);

    expect(markup).toContain('data-ctox-main-shell=""');
    expect(markup).toContain("No instance selected");
    expect(markup).toContain("Instance connections will appear here");
    expect(markup).not.toContain("iframe");
    expect(markup).not.toContain("webview");
  });
});
