import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { resolveProductModeKeyboardTarget, WorkjetProductModeSwitch } from "./SidebarChrome";

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
    expect(markup).toContain("Business OS");
    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-desktop-layout="titlebar"');
    expect(markup).toContain('data-product-mode-switch=""');
    expect(markup).toContain("ml-[var(--workspace-titlebar-control-gap)]");
    expect(markup).toMatch(
      /<button[^>]*class="[^"]*whitespace-nowrap[^"]*"[^>]*data-product-mode="ctox"/,
    );
    expect(markup).not.toContain('aria-label="T3"');
  });

  it("maps radio navigation keys across the complete segmented control", () => {
    expect(resolveProductModeKeyboardTarget("ArrowLeft")).toBe("code");
    expect(resolveProductModeKeyboardTarget("ArrowUp")).toBe("code");
    expect(resolveProductModeKeyboardTarget("Home")).toBe("code");
    expect(resolveProductModeKeyboardTarget("ArrowRight")).toBe("ctox");
    expect(resolveProductModeKeyboardTarget("ArrowDown")).toBe("ctox");
    expect(resolveProductModeKeyboardTarget("End")).toBe("ctox");
    expect(resolveProductModeKeyboardTarget("Enter")).toBeNull();
  });
});
