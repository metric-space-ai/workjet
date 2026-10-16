import * as Schema from "effect/Schema";
import {
  WorkjetGatewayStatus,
  WorkjetGatewayCatalog,
  WorkjetGatewayHealth,
  WorkjetGatewayModelChecks,
  WorkjetGatewayModelDiscovery,
  WorkjetGatewayAccountModels,
  type EnvironmentId,
  type WorkjetGatewayAccountModelsInput,
} from "@workjet/contracts";
import type { CtoxAppApi } from "./ctoxClient";
import { createCtoxReadAtomFamily } from "./readAtoms";
import { CtoxLocalReadError } from "./projectReadData";

type Target<T> = { readonly environmentId: EnvironmentId; readonly input: T };
function rows(api: CtoxAppApi, collection: string) {
  return api
    .query<Record<string, unknown>>(collection, { selector: { is_deleted: { $ne: true } } })
    .get();
}
function state(api: CtoxAppApi) {
  const source = api.get<Record<string, unknown>>("workjet_gateway_state", "gateway").get();
  if (!source)
    throw new CtoxLocalReadError(
      "not_found",
      "provider_registry_missing",
      "workjet_gateway_state/gateway",
    );
  return source;
}
const status = createCtoxReadAtomFamily<Target<Record<string, never>>, WorkjetGatewayStatus>({
  collections: ["workjet_gateway_state"],
  read: (api) => Schema.decodeUnknownSync(WorkjetGatewayStatus)(state(api)),
});
const catalog = createCtoxReadAtomFamily<Target<Record<string, never>>, WorkjetGatewayCatalog>({
  collections: [
    "workjet_gateway_state",
    "workjet_gateway_accounts",
    "workjet_gateway_pools",
    "workjet_gateway_routes",
    "workjet_gateway_models",
    "workjet_gateway_provider_models",
    "workjet_gateway_provider_pools",
  ],
  read: (api) => {
    const metadata = state(api);
    // The legacy schema has defaults. V4 requires actual producer facts instead.
    if (metadata.routingStrategy === undefined)
      throw new CtoxLocalReadError(
        "not_found",
        "routing_strategy_missing",
        "workjet_gateway_state",
      );
    return Schema.decodeUnknownSync(WorkjetGatewayCatalog)({
      schemaVersion: 1,
      routingStrategy: metadata.routingStrategy,
      accounts: rows(api, "workjet_gateway_accounts"),
      pools: rows(api, "workjet_gateway_pools"),
      routes: rows(api, "workjet_gateway_routes"),
      models: rows(api, "workjet_gateway_models"),
      providerModels: rows(api, "workjet_gateway_provider_models"),
      providerPools: rows(api, "workjet_gateway_provider_pools"),
    });
  },
});
const health = createCtoxReadAtomFamily<Target<Record<string, never>>, WorkjetGatewayHealth>({
  collections: [
    "workjet_gateway_state",
    "workjet_gateway_provider_health",
    "workjet_gateway_account_health",
  ],
  read: (api) =>
    Schema.decodeUnknownSync(WorkjetGatewayHealth)({
      ...state(api),
      schemaVersion: 1,
      providers: rows(api, "workjet_gateway_provider_health"),
      accounts: rows(api, "workjet_gateway_account_health"),
    }),
});
const checks = createCtoxReadAtomFamily<Target<Record<string, never>>, WorkjetGatewayModelChecks>({
  collections: [
    "workjet_gateway_state",
    "workjet_gateway_model_checks",
    "workjet_gateway_pending_checks",
  ],
  read: (api) =>
    Schema.decodeUnknownSync(WorkjetGatewayModelChecks)({
      schemaVersion: 1,
      deferredCount: state(api).deferredCount,
      checks: rows(api, "workjet_gateway_model_checks"),
      pending: rows(api, "workjet_gateway_pending_checks"),
    }),
});
const models = createCtoxReadAtomFamily<
  Target<Record<string, never>>,
  WorkjetGatewayModelDiscovery
>({
  collections: ["workjet_gateway_state", "workjet_gateway_model_discovery"],
  read: (api) =>
    Schema.decodeUnknownSync(WorkjetGatewayModelDiscovery)({
      schemaVersion: 1,
      observedAtMs: state(api).observedAtMs,
      providers: rows(api, "workjet_gateway_model_discovery"),
    }),
});
const accountModels = createCtoxReadAtomFamily<
  Target<WorkjetGatewayAccountModelsInput>,
  WorkjetGatewayAccountModels
>({
  collections: ["workjet_gateway_account_models"],
  read: (api, target) => {
    const source = api
      .query("workjet_gateway_account_models", {
        selector: { accountId: target.input.accountId, is_deleted: { $ne: true } },
      })
      .get();
    if (source.length !== 1)
      throw new CtoxLocalReadError(
        "not_found",
        "account_models_missing",
        "workjet_gateway_account_models",
      );
    return Schema.decodeUnknownSync(WorkjetGatewayAccountModels)(source[0]);
  },
});
/** Account authority is the selected Core, independently of which machine runs a thread. */
export const ctoxGatewayReads = {
  workjetGatewayStatus: (target: Target<Record<string, never>>) => status(JSON.stringify(target)),
  workjetGatewayCatalog: (target: Target<Record<string, never>>) => catalog(JSON.stringify(target)),
  workjetGatewayHealth: (target: Target<Record<string, never>>) => health(JSON.stringify(target)),
  workjetGatewayModelChecks: (target: Target<Record<string, never>>) =>
    checks(JSON.stringify(target)),
  workjetGatewayModels: (target: Target<Record<string, never>>) => models(JSON.stringify(target)),
  workjetGatewayAccountModels: (target: Target<WorkjetGatewayAccountModelsInput>) =>
    accountModels(JSON.stringify(target)),
};
