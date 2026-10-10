import type { WorkjetGatewayCatalog } from "@workjet/contracts";
import {
  resolveWorkjetGatewayModelRoute,
  WORKJET_GATEWAY_PROVIDER_HEADER,
} from "@workjet/contracts";
import { GATEWAY_PLACEHOLDER_API_KEY, normalizeGatewayBaseUrl } from "../ProviderGatewayRouting.ts";

export const MINIMAX_GATEWAY_PROFILE_PROVIDER = "workjet-gateway";

/** Configuration for a dedicated Workjet profile, never the user's native profile. */
export function miniMaxGatewayProfileConfiguration(
  providerEndpoint: string,
  catalog: WorkjetGatewayCatalog,
  selectedModel: string,
) {
  const selection = resolveWorkjetGatewayModelRoute({ catalog, model: selectedModel });
  if (selection.outcome !== "resolved") {
    throw new Error(
      selection.outcome === "failed"
        ? selection.detail
        : "Choose a model from a connected Workjet gateway account.",
    );
  }
  const models = Object.fromEntries(
    catalog.models.flatMap((entry) => {
      const route = resolveWorkjetGatewayModelRoute({ catalog, model: entry.id });
      return route.outcome === "resolved"
        ? [[entry.id, { headers: { [WORKJET_GATEWAY_PROVIDER_HEADER]: route.provider } }]]
        : [];
    }),
  );
  if (!Object.hasOwn(models, selectedModel)) {
    throw new Error("The selected model is absent from the connected gateway catalog.");
  }
  return {
    defaultModel: `custom_provider:${MINIMAX_GATEWAY_PROFILE_PROVIDER}/${selectedModel}`,
    custom_provider: {
      [MINIMAX_GATEWAY_PROFILE_PROVIDER]: {
        name: "Workjet gateway",
        kind: "custom",
        enabled: true,
        api: "anthropic-messages",
        options: {
          baseURL: normalizeGatewayBaseUrl(providerEndpoint),
          apiKey: GATEWAY_PLACEHOLDER_API_KEY,
          authMode: "api-key",
        },
        models,
      },
    },
  };
}
