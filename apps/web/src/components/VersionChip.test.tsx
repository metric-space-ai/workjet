import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { formatVersionChipLabel, VersionChipView } from "./VersionChip";

describe("formatVersionChipLabel", () => {
  it("shows the full version line with the instance build as a short SHA", () => {
    expect(formatVersionChipLabel("0.0.85", "0.1.3", "welsch", "5a8db7e28c0f513eb")).toBe(
      "Workjet 0.0.85 · Host 0.1.3 · welsch 5a8db7e",
    );
  });

  it("leaves out unknown parts instead of showing dashes", () => {
    expect(formatVersionChipLabel("0.0.85", null, "welsch")).toBe("Workjet 0.0.85 · welsch");
    expect(formatVersionChipLabel("0.0.85", "0.1.3", null)).toBe("Workjet 0.0.85 · Host 0.1.3");
  });
});

describe("VersionChipView", () => {
  it("is a plain details button without an update", () => {
    const html = renderToStaticMarkup(
      <VersionChipView label="Workjet 0.0.103" update={null} onOpenDetails={() => {}} />,
    );
    expect(html).toContain('data-slot="version-chip"');
    expect(html).not.toContain("data-workjet-provider-update");
  });

  it("folds a harness update into the one version chip as a dot, not a second amber pill", () => {
    const html = renderToStaticMarkup(
      <VersionChipView
        label="Workjet 0.0.103"
        update={{ title: "Codex 0.162.1 verfügbar", onOpen: () => {}, onDismiss: () => {} }}
        onOpenDetails={() => {}}
      />,
    );
    expect(html.match(/data-slot="version-chip"/g)).toHaveLength(1);
    expect(html).toContain("data-workjet-provider-update");
    expect(html).toContain("Codex 0.162.1 verfügbar");
    expect(html).not.toMatch(/amber|rounded-full border/);
  });
});
