import { GitBranchIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Banner } from "./banner";

describe("Banner", () => {
  it("wraps its line instead of truncating and keeps both buttons", () => {
    const markup = renderToStaticMarkup(
      <Banner
        icon={GitBranchIcon}
        action={{ label: "Wechseln", onClick: () => undefined }}
        secondaryAction={{ label: "Abbrechen", onClick: () => undefined }}
      >
        Ungesicherte Änderungen gehen beim Wechsel mit nach feature/drei-orte
      </Banner>,
    );
    expect(markup).not.toContain("truncate");
    expect(markup).toContain("flex-wrap");
    expect(markup).toContain('data-slot="banner-actions"');
    expect(markup).toContain("Wechseln");
    expect(markup).toContain("Abbrechen");
  });

  it("renders no empty action area without buttons", () => {
    const markup = renderToStaticMarkup(<Banner icon={GitBranchIcon}>Nur eine Zeile</Banner>);
    expect(markup).not.toContain('data-slot="banner-actions"');
  });
});
