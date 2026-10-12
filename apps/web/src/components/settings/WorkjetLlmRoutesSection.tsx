import type {
  WorkjetConfiguration,
  WorkjetGatewayCatalog,
  WorkjetLlmRoute,
} from "@workjet/contracts";
import { Fragment, useState } from "react";
import { PlusIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Row } from "../ui/row";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";
import { WorkjetGatewayModelRoutes } from "./WorkjetGatewayModelRoutes";
import { WorkjetLlmRouteEditor } from "./WorkjetLlmRouteEditor";
import { toastManager } from "../ui/toast";

/**
 * LLM routes, ON THE MODELS PAGE.
 *
 * The operator's structure: Models owns everything about LLM access —
 * accounts, pools, and the routes workers reference. Routes used to be tab
 * four inside the Worker section, which meant configuring a worker sent the
 * operator to a different area to create the route the worker needs, while
 * the accounts the route points at lived on Models all along. One subject,
 * one page.
 *
 * Extracted 1:1 from WorkjetSettings; the section keeps its anchor id, so
 * settings search and old `#workjet-llm-routes` links keep landing here.
 */
/**
 * Name the account, never its raw id: an opaque hash the operator cannot
 * recognise. A missing account says so in one short line.
 */
function describeRouteAccount(accountId: string, catalog: WorkjetGatewayCatalog | null): string {
  const account = catalog?.accounts.find((candidate) => candidate.id === accountId);
  if (account === undefined) return "Konto fehlt im Katalog";
  const suffix = account.credentialSuffix ? ` · …${account.credentialSuffix}` : "";
  return `${account.label} · ${account.provider}${suffix}`;
}

export function WorkjetLlmRoutesSection(props: {
  readonly configuration: WorkjetConfiguration;
  readonly catalog: WorkjetGatewayCatalog | null;
  readonly onChange: (configuration: WorkjetConfiguration) => void;
}) {
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [addingRoute, setAddingRoute] = useState(false);
  const editingRoute =
    props.configuration.llmRoutes.find((route) => route.id === editingRouteId) ?? null;

  const routeEditor = (
    <div className="px-3 pt-2 sm:px-4">
      <WorkjetLlmRouteEditor
        key={editingRoute?.id ?? "new-route"}
        route={editingRoute}
        accounts={props.catalog?.accounts ?? []}
        onCancel={() => {
          setAddingRoute(false);
          setEditingRouteId(null);
        }}
        onSave={(route: WorkjetLlmRoute) => {
          props.onChange({
            ...props.configuration,
            llmRoutes: replaceRoute(route),
          });
          setAddingRoute(false);
          setEditingRouteId(null);
          // Same reason as the worker save: the saved row may sit below the
          // fold, so the viewport needs evidence (Befund K-A14).
          toastManager.add({ type: "success", title: "Route gespeichert" });
        }}
      />
    </div>
  );

  const replaceRoute = (route: WorkjetLlmRoute): ReadonlyArray<WorkjetLlmRoute> => {
    const existing = props.configuration.llmRoutes;
    return existing.some((candidate) => candidate.id === route.id)
      ? existing.map((candidate) => (candidate.id === route.id ? route : candidate))
      : [...existing, route];
  };

  return (
    <SettingsSection
      id={searchableSetting("workjet-llm-routes").id}
      title={searchableSetting("workjet-llm-routes").title}
      headerAction={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setEditingRouteId(null);
            setAddingRoute(true);
          }}
        >
          <PlusIcon className="size-3.5" />
          Route hinzufügen
        </Button>
      }
    >
      {addingRoute ? routeEditor : null}
      {props.configuration.llmRoutes.map((route) => (
        <Fragment key={route.id}>
          <Row
            name={route.label}
            meta={
              route.gatewayAccountId === undefined
                ? "Instanz-Konto"
                : describeRouteAccount(route.gatewayAccountId, props.catalog)
            }
            onDelete={() =>
              props.onChange({
                ...props.configuration,
                llmRoutes: props.configuration.llmRoutes.filter(
                  (candidate) => candidate.id !== route.id,
                ),
              })
            }
            deleteLabel="Entfernen"
            deleteConfirmTitle="Route entfernen?"
            menuActions={[
              {
                label: "Bearbeiten",
                onSelect: () => {
                  setAddingRoute(false);
                  setEditingRouteId(route.id);
                },
              },
            ]}
            menuLabel={`Aktionen für ${route.label}`}
          />
          {editingRoute?.id === route.id ? routeEditor : null}
        </Fragment>
      ))}
      <WorkjetGatewayModelRoutes catalog={props.catalog} />
    </SettingsSection>
  );
}
