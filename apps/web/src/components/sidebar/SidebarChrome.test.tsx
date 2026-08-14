import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkjetProductModeSwitch } from "./SidebarChrome";

describe("WorkjetProductModeSwitch", () => {
  it.each(["code", "ctox"] as const)("exposes %s as the selected radio", (mode) => {
    const markup = renderToStaticMarkup(
      <WorkjetProductModeSwitch mode={mode} onBackdrop={false} onModeChange={() => {}} />,
    );

    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="Workjet product mode"');
    expect(markup).toMatch(
      new RegExp(
        `<button[^>]*aria-checked="true"[^>]*data-product-mode="${mode}"[^>]*role="radio"[^>]*tabindex="0"`,
      ),
    );
    expect(markup).toContain("Code");
    expect(markup).toContain("CTOX");
  });
});
