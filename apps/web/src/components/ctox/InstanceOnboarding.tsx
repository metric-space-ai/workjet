import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCwIcon, ServerIcon } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { CtoxDiscoveryResult, CtoxManagedInstance } from "@workjet/contracts";
import { canActivateCtoxInstance, useCtoxMode } from "./CtoxModeShell";
import { Button } from "../ui/button";
import { Row, type RowStatus } from "../ui/row";
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

/** Ein Laden endet immer (UI-Vertrag §1.3): nach 10 s Statuszeile mit Aktionen. */
export const INSTANCE_ONBOARDING_SLOW_MS = 10_000;

/**
 * Startet für „loading“ und „connecting“ den 10-s-Timer und meldet danach
 * `onSlow`. Gibt die Aufräumfunktion zurück; andere Zustände warten nicht.
 */
export function startInstanceOnboardingSlowTimer(
  state: InstanceOnboardingState,
  onSlow: () => void,
  timeoutMs: number = INSTANCE_ONBOARDING_SLOW_MS,
): (() => void) | undefined {
  if (state !== "loading" && state !== "connecting") return undefined;
  const timer = setTimeout(onSlow, timeoutMs);
  return () => clearTimeout(timer);
}

function useInstanceOnboardingSlow(state: InstanceOnboardingState): boolean {
  const [slowState, setSlowState] = useState<InstanceOnboardingState | null>(null);
  useEffect(() => {
    const stop = startInstanceOnboardingSlowTimer(state, () => setSlowState(state));
    return () => {
      stop?.();
      setSlowState(null);
    };
  }, [state]);
  return slowState === state;
}

function instanceRowStatus(instance: CtoxManagedInstance): {
  readonly status: RowStatus;
  readonly label: string;
} {
  if (!canActivateCtoxInstance(instance)) return { status: "off", label: "getrennt" };
  return instance.healthSummary.dataPlaneReady
    ? { status: "ok", label: "verbunden" }
    : { status: "busy", label: "prüft …" };
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
  onManage = () => {},
  slow: slowOverride,
}: {
  readonly state: Exclude<InstanceOnboardingState, "ready">;
  /** Nur für Tests: erzwingt den Zustand nach Ablauf der 10 s. */
  readonly slow?: boolean;
  readonly instances: readonly CtoxManagedInstance[];
  readonly selectedId?: string | null;
  readonly onSelect: (instance: CtoxManagedInstance) => void;
  readonly onRetry: () => void;
  /** Öffnet Einstellungen › Instanzen (dort liegt auch „Instanz hinzufügen“). */
  readonly onManage?: () => void;
}) {
  const selected = instances.find((instance) => instance.id === selectedId);
  const slowTimer = useInstanceOnboardingSlow(state);
  const slow = slowOverride ?? slowTimer;
  const reconnect = (
    <Button size="sm" onClick={onRetry}>
      <RefreshCwIcon />
      Erneut verbinden
    </Button>
  );
  // D36: ein Fehler hat genau eine Aktion; „Instanzen verwalten“ bleibt über
  // den Instanzwähler erreichbar. Nach 10 s ersetzt der Titel die Wartezeile.
  let title: string;
  let actions: ReactNode;
  if (state === "loading") {
    title = slow ? "Instanzen nicht geladen" : "Instanzen werden geladen …";
    actions = slow ? reconnect : null;
  } else if (state === "connecting") {
    title = slow
      ? `${selected?.displayName ?? "Instanz"} nicht verbunden`
      : `${selected?.displayName ?? "Instanz"} wird verbunden …`;
    actions = slow ? reconnect : null;
  } else if (state === "failed") {
    title = `${selected?.displayName ?? "Instanz"} ist nicht erreichbar`;
    actions = reconnect;
  } else if (state === "select") {
    title = "Instanz wählen";
    actions = null;
  } else {
    // D37: Titel und Knopf sagen dasselbe.
    title = "Instanz hinzufügen";
    actions = (
      <Button size="sm" onClick={onManage}>
        Instanz hinzufügen
      </Button>
    );
  }
  return (
    <div
      className="flex min-h-0 flex-1 items-start justify-center overflow-auto px-6 py-16"
      data-workjet-onboarding="instance"
      data-state={state}
      data-slow={slow ? "" : undefined}
    >
      <div className="flex w-full max-w-md flex-col gap-4">
        <h1
          className="break-words font-semibold text-[22px]"
          role={state === "failed" || slow ? "alert" : "status"}
        >
          {title}
        </h1>
        {state === "select" ? (
          <div className="flex flex-col divide-y rounded-lg border">
            {instances.map((instance) => {
              const health = instanceRowStatus(instance);
              return (
                <button
                  key={instance.id}
                  type="button"
                  className="w-full text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  data-workjet-action={`instance.select:${instance.id}`}
                  onClick={() => onSelect(instance)}
                >
                  <Row
                    status={health.status}
                    statusLabel={health.label}
                    name={
                      <span className="flex min-w-0 items-center gap-2">
                        <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{instance.displayName}</span>
                      </span>
                    }
                  />
                </button>
              );
            })}
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
  const navigate = useNavigate();
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
      onManage={() => void navigate({ to: "/settings/business-os" })}
    />
  );
}

export function InstanceNavigationBoundary({ children }: { readonly children: ReactNode }) {
  const state = useInstanceOnboardingState();
  if (canMountSelectedInstance(state)) return children;
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="px-4 pt-6 text-[13.5px] text-muted-foreground">
        <p>Keine Instanz geöffnet</p>
      </SidebarContent>
      <SidebarFooter>
        <Button variant="outline" render={<Link to="/settings/business-os" />}>
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
