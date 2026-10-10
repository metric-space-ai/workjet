import {
  resolveWorkjetGatewayModelRoute,
  WORKJET_GATEWAY_PROVIDER_HEADER,
  type WorkjetGatewayCatalog,
} from "@workjet/contracts";
import { GATEWAY_PLACEHOLDER_API_KEY, gatewayVersionedBaseUrl } from "../ProviderGatewayRouting.ts";

export function piGatewayModel(catalog: WorkjetGatewayCatalog, model: string) {
  const route = resolveWorkjetGatewayModelRoute({ catalog, model });
  if (route.outcome !== "resolved") throw new Error(route.detail);
  return { provider: `workjet-${route.provider}`, model: route.model };
}

/** Pi's documented models.json seam, in a private per-instance agent directory. */
export function piGatewayConfiguration(endpoint: string, catalog: WorkjetGatewayCatalog) {
  const providers: Record<
    string,
    {
      baseUrl: string;
      api: "openai-responses";
      apiKey: string;
      headers: Record<string, string>;
      models: { id: string; name: string }[];
    }
  > = {};
  for (const entry of catalog.models) {
    const route = resolveWorkjetGatewayModelRoute({ catalog, model: entry.id });
    if (route.outcome !== "resolved") continue;
    const key = `workjet-${route.provider}`;
    const provider = (providers[key] ??= {
      baseUrl: gatewayVersionedBaseUrl(endpoint),
      api: "openai-responses",
      apiKey: GATEWAY_PLACEHOLDER_API_KEY,
      headers: { [WORKJET_GATEWAY_PROVIDER_HEADER]: route.provider },
      models: [],
    });
    provider.models.push({ id: route.model, name: entry.displayName });
  }
  return { providers };
}
