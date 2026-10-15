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
 * surface has no editor for yet.
 *
 * @module components/settings/WorkjetGatewayModelRoutes
 */
import {
  workjetGatewayModelRouteTable,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayModelRoute,
} from "@workjet/contracts";

import { SettingsRow } from "./settingsLayout";
import { WORKJET_GATEWAY_PROVIDER_LABELS } from "./WorkjetGatewayAccounts";

const ROUTE_REASON_LABELS: Readonly<Record<string, string>> = {
  "model-unrouted": "Keine Route",
  "route-ambiguous": "Route mehrdeutig",
  "model-ambiguous": "Modell mehrdeutig",
  "model-unspecified": "Kein Modell gewählt",
  "catalog-empty": "Kein Modell im Katalog",
};

/**
 * One short line per outcome. Routes and pools are named by their label, never
 * by their raw id; the id appears only when the catalog cannot resolve it.
 */
export function workjetGatewayModelRouteDescription(
  entry: WorkjetGatewayModelRoute,
  catalog: WorkjetGatewayCatalog | null = null,
): string {
  if (entry.outcome === "resolved") {
    const provider = WORKJET_GATEWAY_PROVIDER_LABELS[entry.provider];
    const routeLabel =
      catalog?.routes.find((route) => route.id === entry.routeId)?.label ?? entry.routeId;
    const poolLabel =
      catalog?.pools.find((pool) => pool.id === entry.poolId)?.label ?? entry.poolId;
    const source =
      entry.via === "route"
        ? `Route ${routeLabel}`
        : entry.via === "pool"
          ? `Pool ${poolLabel}`
          : "Konten";
    // When the pool IS the source, naming it twice says nothing new.
    const poolSuffix = entry.poolId === null || entry.via === "pool" ? "" : ` · Pool ${poolLabel}`;
    return `${provider} · ${source}${poolSuffix}`;
  }
  return ROUTE_REASON_LABELS[entry.reason] ?? "";
}

export function WorkjetGatewayModelRoutes({
  catalog,
}: {
  readonly catalog: WorkjetGatewayCatalog | null;
}) {
  const table = catalog === null ? [] : workjetGatewayModelRouteTable(catalog);

  return (
    <>
      <SettingsRow title="Modell-Routing" />
      {table.length === 0 ? (
        <SettingsRow
          title="Keine Modelle"
          status={<span className="text-muted-foreground">Standardanbieter des Gateways</span>}
        />
      ) : (
        table.map((entry) => (
          <SettingsRow
            key={entry.model ?? "unspecified"}
            title={entry.model ?? "Kein Modell"}
            status={
              <span
                className={
                  entry.outcome === "failed"
                    ? "text-xs font-medium text-destructive"
                    : "text-muted-foreground"
                }
              >
                {workjetGatewayModelRouteDescription(entry, catalog)}
              </span>
            }
          />
        ))
      )}
    </>
  );
}
