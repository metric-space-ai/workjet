import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerManualTargetControlsView,
  ComposerModelMenuItems,
} from "./ComposerWorkjetTargetControls";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

const base = {
  configuredInstanceIds: new Set(["greppy-fixture"]),
  configuredDriverKinds: new Set(["greppy"]),
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
    const entries = textOf(
      ComposerModelMenuItems({
        modelSource: "configured",
        models: [
          { id: "claude-local", displayName: "Private Claude", providers: [], accountIds: [] },
        ],
        modelsUnavailableReason: null,
        selectedModelId: "claude-local",
        onSelectModel: () => undefined,
        onEditCustomModel: () => undefined,
      }),
    );
    expect(entries).toContain("Private Claude");
    expect(entries).toContain("Eigene Modell-ID");
    // A configured profile has no provider grouping: "Claude" must not become a group label.
    expect(entries.match(/Claude/g)?.length).toBe(1);
  });

  it("keeps an unlisted current model and the custom-ID entry available", () => {
    const entries = textOf(
      ComposerModelMenuItems({
        modelSource: "configured",
        models: [],
        modelsUnavailableReason: null,
        selectedModelId: "company/private:v2",
        onSelectModel: () => undefined,
        onEditCustomModel: () => undefined,
      }),
    );
    expect(entries).toContain("company/private:v2");
    expect(entries).toContain("eigene ID");
    expect(entries).toContain("Eigene Modell-ID");
  });

  it("groups the gateway catalog by provider", () => {
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
    expect(markup).toContain("Gateway Claude");
    const entries = textOf(
      ComposerModelMenuItems({
        models: [
          {
            id: "claude-gateway",
            displayName: "Gateway Claude",
            providers: ["claude"],
            accountIds: [],
          },
        ],
        modelsUnavailableReason: null,
        selectedModelId: "claude-gateway",
        onSelectModel: () => undefined,
      }),
    );
    expect(entries).toContain("Claude");
    expect(entries).toContain("Gateway Claude");
  });
});
