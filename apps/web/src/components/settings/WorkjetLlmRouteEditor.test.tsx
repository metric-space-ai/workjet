import { ProviderDriverKind, ProviderInstanceId, WorkjetLlmRouteId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkjetLlmRouteDraft,
  saveWorkjetLlmRouteDraft,
  WorkjetLlmRouteEditor,
} from "./WorkjetLlmRouteEditor";

const providerInstances = {
  codex_work: {
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex Work",
    config: { credentialReference: "protected-elsewhere" },
  },
};

describe("WorkjetLlmRouteEditor", () => {
  it("saves only a provider-instance reference without model or credentials", () => {
    const draft = createWorkjetLlmRouteDraft({
      providerInstances,
      id: "route-work",
    });
    const saved = saveWorkjetLlmRouteDraft({ ...draft, label: " Codex production " });

    expect(saved).toEqual({
      id: WorkjetLlmRouteId.make("route-work"),
      label: "Codex production",
      providerInstanceId: ProviderInstanceId.make("codex_work"),
    });
    expect(saved).not.toHaveProperty("modelId");
    expect(JSON.stringify(saved)).not.toContain("protected-elsewhere");
  });

  it("explains that provider secrets remain with the gateway authority", () => {
    const markup = renderToStaticMarkup(
      <WorkjetLlmRouteEditor
        providerInstances={providerInstances}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain("Models stay on workers");
    expect(markup).toContain(
      "credentials stay protected by the provider-gateway account authority",
    );
    expect(markup).not.toContain("protected-elsewhere");
  });

  it("does not present Code harness runtimes as provider-gateway accounts", () => {
    const markup = renderToStaticMarkup(
      <WorkjetLlmRouteEditor
        providerInstances={{}}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain("No Workjet provider-gateway accounts");
    expect(markup).toContain("harness runtimes");
    expect(markup).toContain('disabled=""');
  });
});
