import type { WorkjetGatewayModelSummary } from "@workjet/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";

/** Direct Greppy profiles advertise configured IDs, not an authenticated gateway catalog. */
export function getGreppyManualModelCatalog(
  entry: ProviderInstanceEntry | undefined,
  routeViaGateway: boolean,
): ReadonlyArray<WorkjetGatewayModelSummary> | null {
  if (entry?.driverKind !== "greppy" || routeViaGateway) return null;
  return entry.models.map((model) => ({
    id: model.slug,
    displayName: model.name,
    providers: [],
    accountIds: [],
  }));
}
