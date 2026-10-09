import { resolveWorkjetGatewayModelRoute, WORKJET_GATEWAY_PROVIDER_HEADER, type WorkjetGatewayCatalog } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { GATEWAY_PLACEHOLDER_API_KEY, gatewayVersionedBaseUrl } from "../ProviderGatewayRouting.ts";

const ObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeObject = Schema.decodeUnknownSync(ObjectSchema);

export function openCodeGatewayModel(catalog: WorkjetGatewayCatalog, model: string | undefined): string {
  const route = resolveWorkjetGatewayModelRoute({ catalog, model });
  if (route.outcome !== "resolved") throw new Error(route.detail);
  return `workjet-gateway-${route.provider}/${route.model}`;
}

/** Runtime-only providers: model IDs and upstream selectors come from the connected catalog. */
export function openCodeGatewayConfiguration(endpoint: string, catalog: WorkjetGatewayCatalog, existing?: string): string {
  const configuration = existing?.trim() ? Schema.decodeUnknownSync(Schema.fromJsonString(ObjectSchema))(existing) : {};
  const providers = configuration.provider === undefined ? {} : decodeObject(configuration.provider);
  const gatewayProviders: Record<string, { npm: string; name: string; options: { baseURL: string; apiKey: string; headers: Record<string, string> }; models: Record<string, { name: string }> }> = {};
  for (const model of catalog.models) {
    const route = resolveWorkjetGatewayModelRoute({ catalog, model: model.id });
    if (route.outcome !== "resolved") continue;
    const id = `workjet-gateway-${route.provider}`;
    const provider = gatewayProviders[id] ??= {
      npm: "@ai-sdk/openai",
      name: `Workjet (${route.provider})`,
      options: { baseURL: gatewayVersionedBaseUrl(endpoint), apiKey: GATEWAY_PLACEHOLDER_API_KEY, headers: { [WORKJET_GATEWAY_PROVIDER_HEADER]: route.provider } },
      models: {},
    };
    provider.models[route.model] = { name: model.displayName };
  }
  return Schema.encodeSync(Schema.UnknownFromJsonString)({ ...configuration, provider: { ...providers, ...gatewayProviders }, ...(configuration.enabled_providers === undefined ? {} : { enabled_providers: [...new Set([...Schema.decodeUnknownSync(Schema.Array(Schema.String))(configuration.enabled_providers), ...Object.keys(gatewayProviders)])] }) });
}
