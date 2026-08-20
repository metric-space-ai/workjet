import {
  WorkjetGatewayAccountId,
  WorkjetGatewayPoolId,
  WorkjetGatewayRouteId,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkjetGatewayModelRoutes } from "./WorkjetGatewayModelRoutes";

const account = (
  id: string,
  provider: WorkjetGatewayProvider,
  modelIds: ReadonlyArray<string>,
): WorkjetGatewayCatalog["accounts"][number] => ({
  id: WorkjetGatewayAccountId.make(id),
  label: id,
  provider,
  enabled: true,
  priority: 0,
  weight: 1,
  modelIds,
  credentialSuffix: null,
});

const catalog: WorkjetGatewayCatalog = {
  schemaVersion: 1,
  accounts: [
    account("codex_1", "codex", ["gpt-5.6"]),
    account("kimi_1", "kimi", ["shared-model"]),
    account("zai_1", "zai", ["shared-model", "glm-5.3"]),
  ],
  pools: [
    {
      id: WorkjetGatewayPoolId.make("zai_pool"),
      label: "Z.ai pool",
      provider: "zai",
      accountIds: [WorkjetGatewayAccountId.make("zai_1")],
      modelIds: ["glm-5.3"],
    },
  ],
  routes: [
    {
      id: WorkjetGatewayRouteId.make("codex_route"),
      label: "Codex route",
      poolId: WorkjetGatewayPoolId.make("zai_pool"),
      provider: "zai",
      modelIds: ["gpt-5.6"],
    },
  ],
  models: [
    { id: "gpt-5.6", displayName: "gpt-5.6", providers: ["codex"], accountIds: [] },
    { id: "glm-5.3", displayName: "glm-5.3", providers: ["zai"], accountIds: [] },
    { id: "shared-model", displayName: "shared-model", providers: ["kimi", "zai"], accountIds: [] },
  ],
};

describe("WorkjetGatewayModelRoutes", () => {
  it("shows the resolved upstream per model, naming the route or pool it came from", () => {
    const markup = renderToStaticMarkup(<WorkjetGatewayModelRoutes catalog={catalog} />);

    expect(markup).toContain("Gateway model routing");
    // A route wins over the account catalog, and the row says which route.
    expect(markup).toContain("codex_route");
    expect(markup).toContain("Z.ai (GLM)");
    // The pool fallback names the pool.
    expect(markup).toContain("pool zai_pool");
  });

  it("surfaces an unresolvable model as its typed reason rather than hiding it", () => {
    const markup = renderToStaticMarkup(<WorkjetGatewayModelRoutes catalog={catalog} />);

    // `shared-model` is served by two providers with no route to decide; a
    // session pinned to it fails at start, so the page must not imply it works.
    expect(markup).toContain("shared-model");
    expect(markup).toContain("model-ambiguous");
  });

  it("explains the empty case instead of rendering a blank section", () => {
    const markup = renderToStaticMarkup(<WorkjetGatewayModelRoutes catalog={null} />);

    expect(markup).toContain("No models yet");
    expect(markup).toContain("default provider");
  });

  it("renders no editing control — this view is read-only", () => {
    const markup = renderToStaticMarkup(<WorkjetGatewayModelRoutes catalog={catalog} />);

    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<select");
  });
});
