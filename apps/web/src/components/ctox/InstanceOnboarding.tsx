import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { CtoxDiscoveryResult, CtoxManagedInstance } from "@workjet/contracts";
import { openInstanceSetup } from "../../instanceSetup";
import { canActivateCtoxInstance, useCtoxMode } from "./CtoxModeShell";
import { InstanceNetworkOverview } from "./InstanceNetworkOverview";
import { Button } from "../ui/button";
import { SidebarContent, SidebarFooter, SidebarInset } from "../ui/sidebar";
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
    <SidebarInset className="h-dvh min-h-0 overflow-auto bg-background">
      <main
        className="mx-auto w-full max-w-7xl space-y-6 px-5 py-12 sm:px-8"
        data-workjet-onboarding="instance"
      >
        <header>
          <p className="text-sm text-muted-foreground">Workjet · Netzwerkübersicht</p>
          <h1 className="mt-3 text-3xl font-semibold">Deine Instanzen und Computer</h1>
          <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
            Jede Instanz hat einen CTOX-Master für Sync und Ops. Satelliten-PCs führen Aufgaben aus.
            Mit Desktop- und Mobil-Apps greifst du auf deine Netzwerke zu.
          </p>
          <p className="mt-2 text-sm">
            Wähle eine Instanz, um ihre Dev- und Ops-Ansichten zu öffnen.
          </p>
        </header>
        {state === "loading" ? <p role="status">Gespeicherte Instanzen werden geladen…</p> : null}
        {state === "connecting" ? (
          <p role="status">
            Die ausgewählte Instanz wird verbunden. Projekte werden nach bestätigter Verbindung
            verfügbar.
          </p>
        ) : null}
        {state === "failed" ? (
          <p role="alert" className="text-destructive">
            Die Verbindung konnte nicht bestätigt werden. Prüfe sie erneut oder verbinde eine andere
            Instanz.
          </p>
        ) : null}
        {network ?? <InstanceNetworkOverview instances={instances} onSelect={onSelect} />}
        <section className="grid gap-4 md:grid-cols-2" aria-label="Netzwerk einrichten">
          <div className="rounded-xl border border-border p-5">
            <h2 className="font-medium">Neue CTOX-Instanz als Master einrichten</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Wähle den Zentralrechner für dein neues Netzwerk.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => openInstanceSetup("local")}>
                Dieser Computer
              </Button>
              <Button variant="outline" onClick={() => openInstanceSetup("ssh")}>
                SSH-Rechner
              </Button>
              <Button variant="outline" onClick={() => openInstanceSetup("tailscale")}>
                Tailscale-Rechner
              </Button>
              <Button variant="outline" onClick={() => openInstanceSetup("managed")}>
                Verwaltet bei ctox.dev
              </Button>
            </div>
          </div>
          <div className="rounded-xl border border-border p-5">
            <h2 className="font-medium">Vorhandene CTOX-Instanz verbinden</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Füge diesem Gerät den Zugriff auf ein vorhandenes Netzwerk hinzu.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => openInstanceSetup("qr")}>
                QR-Code scannen
              </Button>
              <Button variant="outline" onClick={() => openInstanceSetup("link")}>
                Link eingeben
              </Button>
              <Button variant="outline" onClick={() => openInstanceSetup("manual")}>
                Server, Raum und Passwort
              </Button>
              <Button variant="outline" onClick={() => openInstanceSetup("managed")}>
                Bei ctox.dev anmelden
              </Button>
            </div>
          </div>
        </section>
        <Button variant="ghost" onClick={onRefresh}>
          Netzwerk erneut prüfen
        </Button>
      </main>
    </SidebarInset>
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
    <InstanceOnboardingView
      state={state}
      instances={instances}
      onSelect={mode.select}
      onRefresh={mode.refresh}
    />
  );
}

export function InstanceNavigationBoundary({ children }: { readonly children: ReactNode }) {
  const state = useInstanceOnboardingState();
  if (state === "ready") return children;
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="px-4 pt-24 text-sm text-muted-foreground">
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
