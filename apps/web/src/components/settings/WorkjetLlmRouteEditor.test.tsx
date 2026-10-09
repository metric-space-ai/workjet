import {
  WorkjetGatewayAccountId,
  WorkjetLlmRouteId,
  type WorkjetGatewayAccountSummary,
} from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkjetLlmRouteDraft,
  saveWorkjetLlmRouteDraft,
  WorkjetLlmRouteEditor,
} from "./WorkjetLlmRouteEditor";

const accounts: ReadonlyArray<WorkjetGatewayAccountSummary> = [
  {
    id: WorkjetGatewayAccountId.make("gateway_account_work"),
    label: "Codex Work",
    provider: "codex",
    enabled: true,
    priority: 1,
    weight: 1,
    modelIds: ["gpt-5.6"],
    credentialSuffix: null,
  },
];

describe("WorkjetLlmRouteEditor", () => {
  it("keeps the native holding account when only the route label changes", () => {
    const native = { id: WorkjetLlmRouteId.make("native"), label: "Native Claude",
      nativeAccountReference: { accountId: "196a89ba-ee86-4413-885c-04ca60e6f291",
        holderInstanceId: "322084e5-8239-48d7-b3c5-c5178fbe5822", accountRevision: 3 } };
    const draft = createWorkjetLlmRouteDraft({ route: native, accounts });
    expect(draft.gatewayAccountId).toBe("");
    expect(saveWorkjetLlmRouteDraft({ ...draft, label: "Renamed Claude" })).toEqual({
      ...native, label: "Renamed Claude",
    });
    const paired = { ...native, gatewayAccountId: accounts[0]!.id };
    expect(saveWorkjetLlmRouteDraft(createWorkjetLlmRouteDraft({ route: paired, accounts }))).toEqual(paired);
  });

  it("saves only a gateway-account reference without model or credentials", () => {
    const draft = createWorkjetLlmRouteDraft({ accounts, id: "route-work" });
    const saved = saveWorkjetLlmRouteDraft({ ...draft, label: " Codex production " });

    expect(saved).toEqual({
      id: WorkjetLlmRouteId.make("route-work"),
      label: "Codex production",
      gatewayAccountId: WorkjetGatewayAccountId.make("gateway_account_work"),
    });
    expect(saved).not.toHaveProperty("providerInstanceId");
    expect(saved).not.toHaveProperty("modelId");
  });

  it("requires a gateway account before saving", () => {
    expect(() =>
      saveWorkjetLlmRouteDraft({ id: "route-1", label: "Route", gatewayAccountId: "" }),
    ).toThrowError("Choose a provider-gateway account.");
  });

  it("offers gateway accounts and explains where secrets stay", () => {
    const markup = renderToStaticMarkup(
      <WorkjetLlmRouteEditor
        accounts={accounts}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain("Provider-gateway account");
    expect(markup).toContain("Codex Work");
    expect(markup).toContain("Models stay on");
    expect(markup).toContain(
      "credentials stay protected by the provider-gateway account authority",
    );
  });

  it("does not present Code harness runtimes as provider-gateway accounts", () => {
    const markup = renderToStaticMarkup(
      <WorkjetLlmRouteEditor accounts={[]} onSave={() => undefined} onCancel={() => undefined} />,
    );

    expect(markup).toContain("No Workjet provider-gateway accounts");
    expect(markup).toContain("harness runtimes");
    expect(markup).toContain('disabled=""');
  });
});
