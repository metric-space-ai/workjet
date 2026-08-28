import type {
  CtoxDiscoveryResult,
  CtoxManagedInstance,
  DesktopCtoxBridge,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { requestCrossModeBusinessOsInstance } from "../crossMode/crossModeBusinessOsHandoff";
import {
  crossModeSelectionMemory,
  type CrossModeSelectionMemory,
} from "../crossMode/crossModeSelectionMemory";
import type { WorkjetProductMode } from "../workjetProductMode";
import { ctoxInstanceDisplayTitle } from "./ctox/ctoxInstanceDisplayTitle";

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

export function selectActiveCtoxInstance({
  instances,
  instanceId,
  productMode,
  memory = crossModeSelectionMemory,
  requestBusinessOsInstance = requestCrossModeBusinessOsInstance,
}: {
  readonly instances: readonly Pick<CtoxManagedInstance, "id">[];
  readonly instanceId: string;
  readonly productMode: WorkjetProductMode;
  readonly memory?: CrossModeSelectionMemory;
  readonly requestBusinessOsInstance?: typeof requestCrossModeBusinessOsInstance;
}): boolean {
  if (!instances.some((instance) => instance.id === instanceId)) return false;
  memory.remember({ mode: "business-os", ctoxInstanceId: instanceId });
  if (memory.read("business-os")?.ctoxInstanceId !== instanceId) return false;
  if (productMode === "ctox") {
    requestBusinessOsInstance({ mode: "business-os", ctoxInstanceId: instanceId });
  }
  return true;
}

function readActiveCtoxInstanceId(): string | null {
  return crossModeSelectionMemory.readActiveCtoxInstanceId();
}

function useCtoxDiscovery(bridge: DesktopCtoxBridge | undefined): InstanceDiscovery {
  const [discovery, setDiscovery] = useState<InstanceDiscovery>("loading");
  useEffect(() => {
    let cancelled = false;
    if (bridge === undefined) {
      setDiscovery({ _tag: "failed", code: "network_error" });
      return;
    }
    void bridge.refresh().then(
      (next) => {
        if (!cancelled) setDiscovery(next);
      },
      () => {
        if (!cancelled) setDiscovery({ _tag: "failed", code: "network_error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge]);
  return discovery;
}

export function ActiveCtoxInstanceSelector({
  productMode,
  bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.ctox,
}: {
  readonly productMode: WorkjetProductMode;
  readonly bridge?: DesktopCtoxBridge;
}) {
  const rememberedId = useSyncExternalStore(
    crossModeSelectionMemory.subscribeToActiveCtoxInstance,
    readActiveCtoxInstanceId,
    readActiveCtoxInstanceId,
  );
  const discovery = useCtoxDiscovery(bridge);
  const instances = useMemo(() => selectableCtoxInstances(discovery), [discovery]);
  const activeId = resolveActiveCtoxInstanceId(instances, rememberedId);
  const lastRequestedId = useRef<string | null>(null);

  useEffect(() => {
    if (productMode !== "ctox" || activeId === null || lastRequestedId.current === activeId) return;
    lastRequestedId.current = activeId;
    requestCrossModeBusinessOsInstance({ mode: "business-os", ctoxInstanceId: activeId });
  }, [activeId, productMode]);

  const selectInstance = useCallback(
    (instanceId: string) => {
      if (
        selectActiveCtoxInstance({
          instances,
          instanceId,
          productMode,
        }) &&
        productMode === "ctox"
      ) {
        lastRequestedId.current = instanceId;
      }
    },
    [instances, productMode],
  );

  const loading = discovery === "loading";
  const failed = discovery !== "loading" && discovery._tag === "failed";

  return (
    <div
      className="order-[-1] shrink-0 border-b border-sidebar-border px-[calc(var(--sidebar-content-inset)+0.5rem)] py-2"
      data-active-ctox-instance-selector=""
      data-active-ctox-instance-id={activeId ?? ""}
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
