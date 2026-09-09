import type { ReactNode } from "react";
import { RefreshCwIcon, SettingsIcon } from "lucide-react";
import { ActiveCtoxInstanceSelector } from "../ActiveCtoxInstanceSelector";
import { Link } from "@tanstack/react-router";
import type { CtoxDiscoveryResult, CtoxManagedInstance } from "@workjet/contracts";
import { openInstanceSetup } from "../../instanceSetup";
import { canActivateCtoxInstance, useCtoxMode } from "./CtoxModeShell";
import { InstanceNetworkOverview } from "./InstanceNetworkOverview";
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

export function InstanceOnboardingView({
  state,
  instances,
  onSelect,
  onRefresh,
  network,
}: {
  readonly state: Exclude<InstanceOnboardingState, "ready">;
  readonly instances: readonly CtoxManagedInstance[];
  readonly onSelect: (instance: CtoxManagedInstance) => void;
  readonly onRefresh: () => void;
  readonly network?: ReactNode;
}) {
  return (
    <div className="network-home" data-workjet-onboarding="instance">
      <main className="network-home-main">
        <div className="network-overview">
          <header className="network-overview-toolbar">
            <div>
              <h1>Netzwerk</h1>
              <p>
                {instances.length === 0
                  ? "Verbinde eine Instanz oder erstelle dein erstes Netzwerk."
                  : "Wähle eine Instanz für Dev & Ops. Klicke auf einen Rechner für Details."}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Netzwerk erneut prüfen"
              onClick={onRefresh}
            >
              <RefreshCwIcon size={16} />
            </Button>
          </header>
          {state === "loading" && (
            <p className="network-home-status" role="status">
              Instanzen werden geladen…
            </p>
          )}
          {state === "connecting" && (
            <p className="network-home-status" role="status">
              Die ausgewählte Instanz wird verbunden…
            </p>
          )}
          {state === "failed" && (
            <p className="network-home-status" role="alert">
              Verbindung nicht bestätigt. Bitte erneut prüfen.
            </p>
          )}
          {network ?? <InstanceNetworkOverview instances={instances} onSelect={onSelect} />}
          {instances.length === 0 && (
            <nav className="network-first-actions" aria-label="Instanz einrichten oder verbinden">
              <button type="button" onClick={() => openInstanceSetup("local")}>
                Dieser Computer
              </button>
              <button type="button" onClick={() => openInstanceSetup("ssh")}>
                SSH-Rechner
              </button>
              <button type="button" onClick={() => openInstanceSetup("tailscale")}>
                Tailscale-Rechner
              </button>
              <button type="button" onClick={() => openInstanceSetup("managed")}>
                ctox.dev
              </button>
              <button type="button" onClick={() => openInstanceSetup("qr")}>
                QR-Code scannen
              </button>
              <button type="button" onClick={() => openInstanceSetup("link")}>
                Link eingeben
              </button>
              <button type="button" onClick={() => openInstanceSetup("manual")}>
                Server, Raum und Passwort
              </button>
            </nav>
          )}
        </div>
      </main>
    </div>
  );
}

export function InstanceOnboarding({
  state,
}: {
  readonly state: Exclude<InstanceOnboardingState, "ready">;
}) {
  const mode = useCtoxMode();
  const instances =
    mode.discovery !== "loading" && mode.discovery._tag === "ready" ? mode.discovery.instances : [];
  return (
    <div className="network-home">
      <header className="network-home-bar" style={isElectron ? { paddingLeft: 100 } : undefined}>
        <h1>Workjet</h1>
        <ActiveCtoxInstanceSelector />
        <Button
          className="ml-auto"
          variant="ghost"
          size="icon-sm"
          aria-label="Einstellungen"
          render={<Link to="/settings/business-os" />}
        >
          <SettingsIcon size={17} />
        </Button>
      </header>
      <InstanceOnboardingView
        state={state}
        instances={instances}
        onSelect={mode.select}
        onRefresh={mode.refresh}
      />
    </div>
  );
}

export function InstanceNavigationBoundary({ children }: { readonly children: ReactNode }) {
  const state = useInstanceOnboardingState();
  if (state === "ready") return children;
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="px-4 pt-6 text-sm text-muted-foreground">
        <p>Wähle auf der Netzwerkübersicht eine Instanz. Danach erscheinen ihre Projekte hier.</p>
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
  const mode = useCtoxMode();
  if (surface === "settings" || state === "ready") return children;
  // The Ops guest must remain mounted to report its initial connection.
  if (surface === "business-os" && mode.selectedId !== null && state === "connecting")
    return children;
  return <InstanceOnboarding state={state} />;
}

/** The network is a workspace of its own; a project sidebar has no scope here. */
export function InstanceSidebarBoundary({
  children,
  surface,
}: {
  readonly children: ReactNode;
  readonly surface: "settings" | "code" | "business-os";
}) {
  const state = useInstanceOnboardingState();
  const mode = useCtoxMode();
  const show =
    surface === "settings" ||
    state === "ready" ||
    (surface === "business-os" && mode.selectedId !== null && state === "connecting");
  return show ? children : null;
}
