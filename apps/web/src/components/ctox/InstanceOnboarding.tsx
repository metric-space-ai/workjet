import { useEffect, useRef, type ReactNode } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { CtoxDiscoveryResult, CtoxManagedInstance } from "@workjet/contracts";
import { canActivateCtoxInstance, useCtoxMode } from "./CtoxModeShell";
import { Button } from "../ui/button";
import { SidebarContent, SidebarFooter } from "../ui/sidebar";
import { SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { isElectron } from "../../env";

export type InstanceOnboardingState =
  | "loading"
  | "create-or-connect"
  | "select"
  | "connecting"
  | "failed"
  | "ready";
export function resolveInstanceOnboardingState(
  discovery: "loading" | CtoxDiscoveryResult,
  selectedId: string | null,
  connection: string,
): InstanceOnboardingState {
  if (discovery === "loading") return "loading";
  if (discovery.keyRecovery?.pendingLogin) return "create-or-connect";
  if (discovery._tag === "failed") return "failed";
  if (discovery._tag !== "ready" || discovery.instances.length === 0) return "create-or-connect";
  const selected = discovery.instances.find((instance) => instance.id === selectedId);
  if (!selected) return "select";
  if (!canActivateCtoxInstance(selected)) return "failed";
  if (connection === "error" || connection === "revoked") return "failed";
  return selected.healthSummary.dataPlaneReady || connection === "ready" ? "ready" : "connecting";
}

export function useInstanceOnboardingState() {
  const mode = useCtoxMode();
  return mode.bridge === undefined
    ? "ready"
    : resolveInstanceOnboardingState(mode.discovery, mode.selectedId, mode.connection);
}

/**
 * A valid selection mounts its workspace while connection is still pending.
 * Code has its own native project/authority checks; waiting for the Ops guest
 * to become ready would deadlock Code because that guest is not visible there.
 * This does not promote connection or discovery health to ready.
 */
export function canMountSelectedInstance(
  state: InstanceOnboardingState,
): state is "ready" | "connecting" {
  return state === "ready" || state === "connecting";
}

/**
 * Drei Orte (Dev, Ops, Einstellungen): Kann die gewählte Instanz nicht
 * geöffnet werden, zeigt der Arbeitsbereich einen ruhigen Zustand mit einer
 * klaren Aktion, nie die Netzwerkansicht. Die Netzwerkansicht lebt in
 * Einstellungen › Instanzen.
 */
export function InstanceOnboardingView({
  state,
  instances,
  selectedId,
  onSelect,
  onRetry,
}: {
  readonly state: Exclude<InstanceOnboardingState, "ready">;
  readonly instances: readonly CtoxManagedInstance[];
  readonly selectedId?: string | null;
  readonly onSelect: (instance: CtoxManagedInstance) => void;
  readonly onRetry: () => void;
}) {
  const selected = instances.find((instance) => instance.id === selectedId);
  const manage = (
    <Button variant="outline" size="sm" render={<Link to="/settings/business-os" />}>
      Instanzen verwalten
    </Button>
  );
  let title: string;
  let actions: ReactNode;
  if (state === "loading") {
    title = "Instanzen werden geladen …";
    actions = null;
  } else if (state === "connecting") {
    title = `${selected?.displayName ?? "Instanz"} wird verbunden …`;
    actions = null;
  } else if (state === "failed") {
    title = `${selected?.displayName ?? "Instanz"} ist nicht erreichbar`;
    actions = (
      <>
        <Button size="sm" onClick={onRetry}>
          <RefreshCwIcon />
          Erneut verbinden
        </Button>
        {manage}
      </>
    );
  } else if (state === "select") {
    title = "Instanz wählen";
    actions = null;
  } else {
    title = "Instanz verbinden";
    actions = (
      <Button size="sm" render={<Link to="/settings/business-os" />}>
        Instanz hinzufügen
      </Button>
    );
  }
  return (
    <div
      className="flex min-h-0 flex-1 items-start justify-center overflow-auto px-6 py-16"
      data-workjet-onboarding="instance"
      data-state={state}
    >
      <div className="flex w-full max-w-md flex-col gap-4">
        <h1 className="font-semibold text-[22px]" role={state === "failed" ? "alert" : "status"}>
          {title}
        </h1>
        {state === "select" ? (
          <div className="flex flex-col divide-y rounded-lg border">
            {instances.map((instance) => (
              <button
                key={instance.id}
                type="button"
                className="flex items-center gap-3 px-3 py-2 text-left text-[13.5px] hover:bg-accent"
                onClick={() => onSelect(instance)}
              >
                <span className="font-medium">{instance.displayName}</span>
              </button>
            ))}
          </div>
        ) : null}
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function WorkjetKeyRecoveryView({
  onLogin,
  busy = false,
}: {
  readonly onLogin: () => void;
  readonly busy?: boolean;
  readonly catalogReset?: boolean;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 items-start justify-center px-6 py-16"
      data-workjet-onboarding="key-recovery"
    >
      <div className="flex w-full max-w-md flex-col gap-4">
        <h1 className="font-semibold text-[22px]" role="status">
          Neu anmelden
        </h1>
        <div>
          <Button size="sm" onClick={onLogin} disabled={busy}>
            Bei ctox.dev anmelden
          </Button>
        </div>
      </div>
    </div>
  );
}

const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

export function InstanceOnboarding({
  state,
}: {
  readonly state: Exclude<InstanceOnboardingState, "ready">;
}) {
  const mode = useCtoxMode();
  const instances =
    mode.discovery !== "loading" && mode.discovery._tag === "ready" ? mode.discovery.instances : [];
  const selected = instances.find((instance) => instance.id === mode.selectedId);
  const retry = () => {
    if (selected) void mode.select(selected);
    else mode.refresh();
  };
  // Ein Verbindungsfehler bleibt sonst stehen, bis jemand neu auswählt.
  // Workjet versucht es deshalb selbst erneut, mit wachsendem Abstand.
  const attemptRef = useRef(0);
  useEffect(() => {
    if (state !== "failed" || selected === undefined) {
      attemptRef.current = 0;
      return;
    }
    const delay =
      RETRY_DELAYS_MS[Math.min(attemptRef.current, RETRY_DELAYS_MS.length - 1)] ?? 300_000;
    const timer = window.setTimeout(() => {
      attemptRef.current += 1;
      void mode.select(selected);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [state, selected, mode]);
  if (mode.discovery !== "loading" && mode.discovery.keyRecovery?.pendingLogin)
    return <WorkjetKeyRecoveryView onLogin={mode.login} busy={mode.refreshing} />;
  return (
    <InstanceOnboardingView
      state={state}
      instances={instances}
      selectedId={mode.selectedId}
      onSelect={(instance) => void mode.select(instance)}
      onRetry={retry}
    />
  );
}

export function InstanceNavigationBoundary({ children }: { readonly children: ReactNode }) {
  const state = useInstanceOnboardingState();
  if (canMountSelectedInstance(state)) return children;
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="px-4 pt-6 text-sm text-muted-foreground">
        <p>Keine Instanz geöffnet</p>
      </SidebarContent>
      <SidebarFooter>
        <Button variant="ghost" render={<Link to="/settings/business-os" />}>
          Instanzen verwalten
        </Button>
      </SidebarFooter>
    </>
  );
}

export function InstanceWorkspaceBoundary({
  children,
  surface,
}: {
  readonly children: ReactNode;
  readonly surface: "settings" | "code" | "business-os";
}) {
  const state = useInstanceOnboardingState();
  if (surface === "settings" || canMountSelectedInstance(state)) return children;
  return <InstanceOnboarding state={state} />;
}

/**
 * Die Seitenleiste bleibt immer stehen, damit die App gleich aussieht;
 * ohne geöffnete Instanz zeigt InstanceNavigationBoundary eine kurze Zeile.
 */
export function InstanceSidebarBoundary({
  children,
}: {
  readonly children: ReactNode;
  readonly surface: "settings" | "code" | "business-os";
}) {
  return children;
}
