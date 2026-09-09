import { useEffect, useState, useSyncExternalStore } from "react";
import { LaptopIcon, NetworkIcon, PlusIcon, ServerIcon, SmartphoneIcon } from "lucide-react";
import type {
  CtoxInstanceAppsResult,
  CtoxManagedInstance,
  EnvironmentId,
  WorkjetDeviceBindingSummary,
} from "@workjet/contracts";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { createComputerMembershipStore } from "../../workjetComputerMembership";
import { openInstanceSetup } from "../../instanceSetup";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { workjetHarnessDisplayLabel } from "../settings/WorkjetWorkerEditor";
import { WorkjetComputersSettings } from "../settings/WorkjetComputersSettings";
import { listBusinessOsDevices } from "../settings/businessOsDeviceControl";
import { canActivateCtoxInstance, useCtoxMode } from "./CtoxModeShell";
import { ctoxInstanceDisplayTitle } from "./ctoxInstanceDisplayTitle";

export function instanceHostLabel(instance: CtoxManagedInstance): string {
  if (instance.source === "local_daemon") return "Dieser Computer";
  if (instance.domain) return instance.domain;
  if (instance.source === "ctox_dev") return "Verwaltet bei ctox.dev";
  if (instance.source === "ssh_managed") return "SSH-Rechner · Hostname noch nicht gemeldet";
  return "Hostname noch nicht gemeldet";
}

export function instanceAppsLabel(result: CtoxInstanceAppsResult | null): string {
  if (result === null || result._tag !== "completed") return "Apps: noch nicht geprüft";
  if (result.source === "cache" && result.apps.length === 0) return "Apps: noch nicht geprüft";
  return `${result.apps.length} Apps${result.source === "cache" ? " · zuletzt bekannt" : ""}`;
}

function ComputerHarnesses({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    serverEnvironment.workjetHarnessInspect({ environmentId, input: {} }),
  );
  if (query.error || !query.data)
    return <p className="mt-2 text-xs text-muted-foreground">Harnesses: noch nicht geprüft</p>;
  return (
    <div className="mt-2 space-y-1 text-xs">
      {query.data.harnesses.map((harness) => (
        <p key={harness.harness} className="text-muted-foreground">
          {workjetHarnessDisplayLabel(harness.harness)} ·{" "}
          {harness.availability === "available" ? "Einsatzbereit" : "Nicht einsatzbereit"}
        </p>
      ))}
      <p className="pt-1 text-muted-foreground">Laufende Harness-Aufgaben: noch nicht gemeldet</p>
    </div>
  );
}

function InstanceNode({
  instance,
  onSelect,
}: {
  readonly instance: CtoxManagedInstance;
  readonly onSelect: (instance: CtoxManagedInstance) => void;
}) {
  const { bridge, appRailVersion } = useCtoxMode();
  const [membershipStore] = useState(createComputerMembershipStore);
  const membership = useSyncExternalStore(
    membershipStore.subscribe,
    membershipStore.getSnapshot,
    membershipStore.getSnapshot,
  );
  const [apps, setApps] = useState<CtoxInstanceAppsResult | null>(null);
  const [devices, setDevices] = useState<readonly WorkjetDeviceBindingSummary[] | null>(null);
  const [configure, setConfigure] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const { environments } = useEnvironments();
  const computers = usePrimarySettings((settings) => settings.workjet.computers);
  useEffect(() => {
    let cancelled = false;
    setApps(null);
    setDevices(null);
    void membershipStore.refresh(instance.id, bridge);
    if (bridge) {
      void bridge.listApps(instance.id).then(
        (result) => {
          if (!cancelled && (result._tag !== "completed" || result.instanceId === instance.id))
            setApps(result);
        },
        () => {
          if (!cancelled) setApps(null);
        },
      );
      void listBusinessOsDevices(bridge, instance.id, instance.id).then(
        (result) => {
          if (!cancelled) setDevices(result.devices);
        },
        () => {
          if (!cancelled) setDevices(null);
        },
      );
    }
    return () => {
      cancelled = true;
      membershipStore.select(null);
    };
  }, [bridge, instance.id, appRailVersion, membershipStore, revision]);
  const available = canActivateCtoxInstance(instance);
  const assigned =
    membership.instanceId === instance.id && membership.phase === "ready"
      ? membership.computers.filter((computer) => computer.status === "assigned")
      : null;
  const host = assigned?.find((computer) => computer.selfHostedColocation);
  const hostComputer = host ? computers.find((computer) => computer.id === host.id) : undefined;
  const hostConnected =
    hostComputer &&
    environments.some(
      (environment) =>
        environment.environmentId === hostComputer.environmentId &&
        environment.connection.phase === "connected",
    );
  return (
    <article
      className="rounded-2xl border border-border bg-card/30 p-5"
      data-workjet-network-instance={instance.id}
    >
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{ctoxInstanceDisplayTitle(instance)}</h2>
          <p className="text-xs text-muted-foreground">
            Eigenes Netzwerk · gemeinsamer Sync über den CTOX-Master
          </p>
        </div>
        <Button size="sm" disabled={!available} onClick={() => onSelect(instance)}>
          {available ? "Instanz auswählen" : "Derzeit nicht erreichbar"}
        </Button>
      </header>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-xl border border-border p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <SmartphoneIcon className="size-4" aria-hidden />
            Desktop- und Mobil-Clients
          </h3>
          <p className="mt-2 text-xs text-muted-foreground">
            {devices === null
              ? "Registrierte Geräte: noch nicht geprüft"
              : `${devices.length} registrierte Geräte`}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Aktuell verbundene Benutzer und Clients: noch nicht gemeldet.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Ein Client kann auf mehrere Instanzen zugreifen.
          </p>
        </section>
        <section className="min-w-0 rounded-xl border border-primary/40 bg-primary/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <ServerIcon className="size-4" aria-hidden />
            Zentralrechner
          </p>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {host?.displayName ?? instanceHostLabel(instance)}
          </p>
          <div className="mt-4 rounded-lg border border-primary/25 p-3 text-sm">
            <h3 className="flex items-center gap-2 font-medium">
              <NetworkIcon className="size-4" aria-hidden />
              CTOX-Master
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">Sync · Projekte · Aufgaben</p>
            <p className="mt-2 text-xs">Ops / Business OS · {instanceAppsLabel(apps)}</p>
          </div>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer">Harnesses auf dem Zentralrechner</summary>
            {hostConnected && hostComputer ? (
              <ComputerHarnesses environmentId={hostComputer.environmentId} />
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">Noch nicht geprüft</p>
            )}
          </details>
        </section>
        <section className="min-w-0 space-y-3 border-l-2 border-primary/25 pl-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <LaptopIcon className="size-4" aria-hidden />
            Satelliten-PCs
          </h3>
          {assigned === null ? (
            <p className="text-xs text-muted-foreground">
              Die Instanz hat ihre Computerzuordnung noch nicht bestätigt.
            </p>
          ) : assigned.filter((computer) => !computer.selfHostedColocation).length === 0 ? (
            <p className="text-xs text-muted-foreground">Noch keine Satelliten-PCs zugeordnet.</p>
          ) : null}
          {assigned
            ?.filter((computer) => !computer.selfHostedColocation)
            .map((computer) => {
              const configured = computers.find((candidate) => candidate.id === computer.id);
              const connected =
                configured &&
                environments.some(
                  (environment) =>
                    environment.environmentId === configured.environmentId &&
                    environment.connection.phase === "connected",
                );
              return (
                <details key={computer.id} className="rounded-lg border border-border p-3">
                  <summary className="cursor-pointer break-words text-sm font-medium">
                    {computer.displayName}
                  </summary>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {connected ? "Mit dieser App verbunden" : "Verbindung noch nicht bestätigt"}
                  </p>
                  {connected && configured ? (
                    <ComputerHarnesses environmentId={configured.environmentId} />
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Harnesses: noch nicht geprüft
                    </p>
                  )}
                </details>
              );
            })}
          <Button
            variant="outline"
            className="h-auto w-full whitespace-normal border-dashed py-3 sm:h-auto"
            disabled={!available}
            onClick={() => setConfigure(true)}
          >
            <PlusIcon className="size-4" aria-hidden />
            Satelliten-PC hinzufügen
          </Button>
        </section>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="mt-3"
        onClick={() => setRevision((value) => value + 1)}
      >
        Netzwerk prüfen
      </Button>
      <Dialog
        open={configure}
        onOpenChange={(open) => {
          if (!setupBusy) setConfigure(open);
        }}
      >
        <DialogPopup className="max-h-[85dvh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Computer für {ctoxInstanceDisplayTitle(instance)}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <WorkjetComputersSettings
              instanceId={instance.id}
              setupOnly
              onBusyChange={setSetupBusy}
              onCompleted={() => {
                setConfigure(false);
                setRevision((value) => value + 1);
              }}
            />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </article>
  );
}

export function InstanceNetworkOverview({
  instances,
  onSelect,
}: {
  readonly instances: readonly CtoxManagedInstance[];
  readonly onSelect: (instance: CtoxManagedInstance) => void;
}) {
  return (
    <section aria-label="Dein Workjet-Netzwerk" className="space-y-5">
      {instances.map((instance) => (
        <InstanceNode key={instance.id} instance={instance} onSelect={onSelect} />
      ))}
      <button
        type="button"
        className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border bg-muted/10 p-8 text-muted-foreground hover:border-primary/50 hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-primary"
        onClick={() => openInstanceSetup()}
      >
        <ServerIcon className="size-8" aria-hidden />
        <span className="font-medium">
          {instances.length === 0
            ? "Zentralrechner einrichten oder verbinden"
            : "Weiteren CTOX-Master hinzufügen"}
        </span>
        <span className="max-w-md text-center text-sm">
          Neue Instanz auf einem Computer einrichten oder Zugriff auf eine vorhandene Instanz
          hinzufügen.
        </span>
      </button>
    </section>
  );
}
