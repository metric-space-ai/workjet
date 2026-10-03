import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/expandable-settings-popup", () => ({
  ExpandableSettingsPopup: ({ trigger, list }: { trigger: ReactNode; list: ReactNode }) => (
    <>
      {trigger}
      {list}
    </>
  ),
}));

import { ComposerManualTargetControlsView } from "./ComposerWorkjetTargetControls";

const base = {
  configuredInstanceIds: new Set(["greppy"]),
  selectedHarness: "greppy" as const,
  onSelectHarness: () => undefined,
  modelsUnavailableReason: null,
  onSelectModel: () => undefined,
};

describe("Greppy configured model menu", () => {
  it("shows configured choices without inferring a gateway provider from the model ID", () => {
    const markup = renderToStaticMarkup(
      <ComposerManualTargetControlsView
        {...base}
        modelSource="configured"
        models={[
          { id: "claude-local", displayName: "Private Claude", providers: [], accountIds: [] },
        ]}
        selectedModelId="claude-local"
      />,
    );
    expect(markup).toContain('data-model-catalog-source="configured"');
    expect(markup).toContain("Private Claude");
    expect(markup).toContain("Configured models");
    expect(markup).toContain("Availability is checked when a turn starts.");
    expect(markup).toContain("Custom model ID");
    expect(markup).not.toContain('aria-label="Claude"');
    expect(markup).not.toContain("Served by the Workjet gateway");
  });

  it("keeps an unlisted current model and the custom-ID editor available", () => {
    const markup = renderToStaticMarkup(
      <ComposerManualTargetControlsView
        {...base}
        modelSource="configured"
        models={[]}
        selectedModelId="company/private:v2"
      />,
    );
    expect(markup).toContain("company/private:v2");
    expect(markup).toContain("Current custom model");
    expect(markup).toContain("Custom model ID");
  });

  it("retains the existing gateway catalog and provider rail for gateway routing", () => {
    const markup = renderToStaticMarkup(
      <ComposerManualTargetControlsView
        {...base}
        models={[
          {
            id: "claude-gateway",
            displayName: "Gateway Claude",
            providers: ["claude"],
            accountIds: [],
          },
        ]}
        selectedModelId="claude-gateway"
      />,
    );
    expect(markup).toContain('data-model-catalog-source="gateway"');
    expect(markup).toContain('aria-label="Claude"');
    expect(markup).toContain("Served by the Workjet gateway");
    expect(markup).toContain("Gateway Claude");
  });
});
