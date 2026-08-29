import type { CtoxDiscoveryResult, CtoxManagedInstance } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { ctoxInstanceDisplayTitle } from "./ctox/ctoxInstanceDisplayTitle";
import { useCtoxMode } from "./ctox/CtoxModeShell";
import { useActiveWorkjetScope } from "../activeWorkjetScope";

type InstanceDiscovery = "loading" | CtoxDiscoveryResult;

export function selectableCtoxInstances(
  discovery: InstanceDiscovery,
): readonly CtoxManagedInstance[] {
  if (discovery === "loading" || discovery._tag !== "ready") return [];
  // SSH rows are computers used to reach a backend, not independent Business
  // OS instances. Keep them out of the global scope selector.
  return discovery.instances
    .filter((instance) => instance.source !== "ssh_managed")
    .toSorted((left, right) => left.displayName.localeCompare(right.displayName));
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
  const { discovery, selectedId, select } = useCtoxMode();
  const { selectionRevision } = useActiveWorkjetScope();
  const instances = useMemo(() => selectableCtoxInstances(discovery), [discovery]);
  const activeId = resolveActiveCtoxInstanceId(instances, selectedId);

  const selectInstance = useCallback(
    (instanceId: string) => {
      const instance = instances.find((candidate) => candidate.id === instanceId);
      if (instance !== undefined) select(instance);
    },
    [instances, select],
  );

  const loading = discovery === "loading";
  const failed = discovery !== "loading" && discovery._tag === "failed";

  return (
    <div
      className="order-[-1] shrink-0 border-b border-sidebar-border px-[calc(var(--sidebar-content-inset)+0.5rem)] py-2"
      data-active-ctox-instance-selector=""
      data-active-ctox-instance-id={activeId ?? ""}
      data-active-workjet-selection-revision={selectionRevision}
    >
      <label className="block">
        <span className="sr-only">Aktive Business-OS-Instanz</span>
        <select
          aria-label="Aktive Business-OS-Instanz"
          className="h-8 w-full truncate rounded-md border border-sidebar-border bg-sidebar-accent/35 px-2 text-sm font-semibold text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          disabled={loading || failed || instances.length === 0}
          value={activeId ?? ""}
          onChange={(event) => selectInstance(event.currentTarget.value)}
        >
          {activeId === null ? (
            <option value="">
              {loading
                ? "Business OS wird geladen…"
                : failed
                  ? "Business OS nicht verfügbar"
                  : "Business OS auswählen"}
            </option>
          ) : null}
          {instances.map((instance) => (
            <option key={instance.id} value={instance.id}>
              {ctoxInstanceDisplayTitle(instance)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
