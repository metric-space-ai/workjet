/**
 * WorkjetGatewayModelRoutes — read-only view of what each model the Workjet
 * provider gateway knows resolves to.
 *
 * This is the operator-facing half of the server's session-start resolution:
 * the same `resolveWorkjetGatewayModelRoute` decides which upstream serves a
 * routed session, so a model shown here as ambiguous or unrouted is exactly a
 * model whose session would fail to start. Rendering it from a second, local
 * re-implementation would let the page reassure an operator about a routing
 * table the server disagrees with.
 *
 * Read-only on purpose: the gateway's `routes` are configuration the settings
 * surface has no editor for yet, and inventing one in the same slice that
 * introduced resolution would ship an editor with no verified write path.
 *
 * @module components/settings/WorkjetGatewayModelRoutes
 */
import {
  workjetGatewayModelRouteTable,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayModelRoute,
} from "@t3tools/contracts";

import { SettingsRow } from "./settingsLayout";
import { WORKJET_GATEWAY_PROVIDER_LABELS } from "./WorkjetGatewayAccounts";

/** One line of prose per outcome, so the row says what happens, not just what failed. */
export function workjetGatewayModelRouteDescription(entry: WorkjetGatewayModelRoute): string {
  if (entry.outcome === "resolved") {
    const provider = WORKJET_GATEWAY_PROVIDER_LABELS[entry.provider];
    const source =
      entry.via === "route"
        ? `route ${entry.routeId}`
        : entry.via === "pool"
          ? `pool ${entry.poolId}`
          : "the accounts that list it";
    // When the pool IS the source, naming it twice ("· pool X — resolved from
    // pool X") says nothing new; the suffix earns its place only when the pool
    // came in through a route.
    const poolSuffix =
      entry.poolId === null || entry.via === "pool" ? "" : ` · pool ${entry.poolId}`;
    return `Served by ${provider}${poolSuffix} — resolved from ${source}.`;
  }
  return entry.detail;
}

export function WorkjetGatewayModelRoutes({
  catalog,
}: {
  readonly catalog: WorkjetGatewayCatalog | null;
}) {
  const table = catalog === null ? [] : workjetGatewayModelRouteTable(catalog);

  return (
    <>
      <SettingsRow
        title="Gateway model routing"
        description="Which Workjet gateway upstream serves each model, resolved exactly as a routed session resolves it at start. Routes are configured on the gateway; this view is read-only."
      />
      {table.length === 0 ? (
        <SettingsRow
          title="No models yet"
          description="No Workjet gateway account declares a model, so a routed session falls back to the gateway's default provider."
        />
      ) : (
        table.map((entry) => (
          <SettingsRow
            key={entry.model ?? "unspecified"}
            title={entry.model ?? "No model selected"}
            description={workjetGatewayModelRouteDescription(entry)}
            status={
              entry.outcome === "failed" ? (
                <span className="text-xs font-medium text-destructive">{entry.reason}</span>
              ) : null
            }
          />
        ))
      )}
    </>
  );
}
