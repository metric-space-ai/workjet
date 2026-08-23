import type {
  WorkjetConfiguration,
  WorkjetGatewayCatalog,
  WorkjetLlmRoute,
} from "@t3tools/contracts";
import { useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { WorkjetGatewayModelRoutes } from "./WorkjetGatewayModelRoutes";
import { WorkjetLlmRouteEditor } from "./WorkjetLlmRouteEditor";

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
export function WorkjetLlmRoutesSection(props: {
  readonly configuration: WorkjetConfiguration;
  readonly catalog: WorkjetGatewayCatalog | null;
  readonly onChange: (configuration: WorkjetConfiguration) => void;
}) {
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [addingRoute, setAddingRoute] = useState(false);
  const editingRoute =
    props.configuration.llmRoutes.find((route) => route.id === editingRouteId) ?? null;

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
          Add route
        </Button>
      }
    >
      <SettingsRow
        title="Provider-gateway accounts"
        description="An LLM route references one Workjet provider-gateway account. Code harness drivers such as Codex, Claude, and Grok are intentionally excluded because they are not LLM accounts. Models remain selected on workers."
      />
      {props.configuration.llmRoutes.map((route) => (
        <SettingsRow
          key={route.id}
          title={route.label}
          description={`Provider-gateway account: ${route.gatewayAccountId}`}
          control={
            <span className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Edit LLM route ${route.label}`}
                onClick={() => {
                  setAddingRoute(false);
                  setEditingRouteId(route.id);
                }}
              >
                <PencilIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Delete LLM route ${route.label}`}
                onClick={() =>
                  props.onChange({
                    ...props.configuration,
                    llmRoutes: props.configuration.llmRoutes.filter(
                      (candidate) => candidate.id !== route.id,
                    ),
                  })
                }
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </span>
          }
        />
      ))}
      <WorkjetGatewayModelRoutes catalog={props.catalog} />
      {addingRoute || editingRoute ? (
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
            }}
          />
        </div>
      ) : null}
    </SettingsSection>
  );
}
