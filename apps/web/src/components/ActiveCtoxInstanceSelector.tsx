import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, PlusIcon } from "lucide-react";
import { openInstanceSetup } from "../instanceSetup";
import { Button } from "./ui/button";
import type { CtoxDiscoveryResult, CtoxManagedInstance } from "@workjet/contracts";
import { useCallback, useMemo, useRef } from "react";

import { CtoxInstanceSelectOption } from "./ctox/CtoxInstanceSelectOption";
import { useCtoxMode } from "./ctox/CtoxModeShell";
import { useActiveWorkjetScope } from "../activeWorkjetScope";

type InstanceDiscovery = "loading" | CtoxDiscoveryResult;

export function selectableCtoxInstances(
  discovery: InstanceDiscovery,
): readonly CtoxManagedInstance[] {
  if (discovery === "loading" || discovery._tag !== "ready") return [];
  return discovery.instances.toSorted((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

export function resolveActiveCtoxInstanceId(
  instances: readonly Pick<CtoxManagedInstance, "id">[],
  rememberedId: string | null,
): string | null {
  if (rememberedId !== null && instances.some((instance) => instance.id === rememberedId)) {
    return rememberedId;
  }
  return null;
}

export function ActiveCtoxInstanceSelector() {
  const navigate = useNavigate();
  const { discovery, selectedId, select, showNetwork } = useCtoxMode();
  const picker = useRef<HTMLSelectElement>(null);
  const { selectionRevision } = useActiveWorkjetScope();
  const instances = useMemo(() => selectableCtoxInstances(discovery), [discovery]);
  const activeId = resolveActiveCtoxInstanceId(instances, selectedId);

  const selectInstance = useCallback(
    (instanceId: string) => {
      if (instanceId === "") {
        void showNetwork().then((accepted) => {
          if (accepted) void navigate({ to: "/" });
        });
        return;
      }
      const instance = instances.find((candidate) => candidate.id === instanceId);
      if (instance !== undefined) select(instance);
    },
    [instances, select, showNetwork, navigate],
  );

  const loading = discovery === "loading";
  const failed = discovery !== "loading" && discovery._tag === "failed";

  return (
    <div
      className="relative order-[-1] shrink-0 border-b border-sidebar-border px-[calc(var(--sidebar-content-inset)+0.5rem)] py-2"
      data-active-ctox-instance-selector=""
      data-active-ctox-instance-id={activeId ?? ""}
      data-active-workjet-selection-revision={selectionRevision}
    >
      <div className="flex items-center gap-1">
        <label className="block min-w-0 flex-1">
          <span className="sr-only">CTOX-Instanz auswählen</span>
          <select
            ref={picker}
            aria-describedby={
              activeId === null && !loading ? "workjet-instance-selection-hint" : undefined
            }
            aria-label="CTOX-Instanz auswählen"
            className="h-8 w-full truncate rounded-md border border-sidebar-border bg-sidebar-accent/35 px-2 text-sm font-semibold text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            disabled={loading || failed || instances.length === 0}
            value={activeId ?? ""}
            onChange={(event) => selectInstance(event.currentTarget.value)}
          >
            <option value="">{loading ? "Instanzen werden geladen…" : "Netzwerkübersicht"}</option>
            {instances.map((instance) => (
              <CtoxInstanceSelectOption key={instance.id} instance={instance} />
            ))}
          </select>
        </label>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Instanz hinzufügen"
          onClick={() => openInstanceSetup()}
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>
      {activeId === null && !loading ? (
        <div
          id="workjet-instance-selection-hint"
          role="status"
          className="mt-2 rounded-lg border border-primary/40 bg-popover p-3 text-sm"
        >
          <ArrowUpIcon aria-hidden className="mb-1 size-5 text-primary" />
          <button
            type="button"
            className="text-left font-medium text-foreground"
            onClick={() => {
              if (instances.length === 0) {
                openInstanceSetup();
                return;
              }
              picker.current?.focus();
              try {
                picker.current?.showPicker();
              } catch {
                /* Focus remains available for keyboard selection. */
              }
            }}
          >
            {instances.length === 0
              ? "Erste Instanz erstellen oder verbinden"
              : "Bitte zuerst eine Instanz wählen"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
