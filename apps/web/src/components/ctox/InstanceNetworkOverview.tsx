import { useEffect, useState, useSyncExternalStore } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { NetworkDiagram } from "./NetworkDiagram";
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
  const [inspected, setInspected] = useState<string | null>(null);
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
  const satelliteNodes =
    assigned
      ?.filter((computer) => !computer.selfHostedColocation)
      .map((computer) => {
        const configured = computers.find((candidate) => candidate.id === computer.id);
        return {
          id: computer.id,
          name: computer.displayName,
          connected: Boolean(
            configured &&
            environments.some(
              (environment) =>
                environment.environmentId === configured.environmentId &&
                environment.connection.phase === "connected",
            ),
          ),
        };
      }) ?? null;
  const inspectedComputer =
    inspected === "master"
      ? hostComputer
      : computers.find(
          (computer) =>
            computer.id === inspected && satelliteNodes?.some((node) => node.id === computer.id),
        );
  const inspectedConnected =
    inspected === "master"
      ? hostConnected
      : satelliteNodes?.find((computer) => computer.id === inspected)?.connected;
  return (
    <article className="network-instance" data-workjet-network-instance={instance.id}>
      <header className="network-instance-header">
        <div className="network-instance-title">
          <h2>{ctoxInstanceDisplayTitle(instance)}</h2>
          <span>
            {instance.source === "local_daemon" ? "Lokal" : (instance.domain ?? "Remote")}
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!available}
          onClick={() => onSelect(instance)}
        >
          {available ? "Instanz auswählen" : "Nicht erreichbar"}
        </Button>
      </header>
      <div className="network-instance-body">
        <NetworkDiagram
          name={ctoxInstanceDisplayTitle(instance)}
          host={host?.displayName ?? instanceHostLabel(instance)}
          ready={instance.healthSummary.dataPlaneReady}
          satellites={satelliteNodes}
          registeredClients={devices?.length ?? null}
          selected={inspected}
          onInspect={setInspected}
          canAdd={available}
          onAdd={() => setConfigure(true)}
        />
        {inspected !== null && (
          <aside className="network-inspector" aria-label="Knotendetails">
            <header className="network-inspector-header">
              <h3>
                {inspected === "master"
                  ? "Zentralrechner"
                  : inspected === "clients"
                    ? "App-Clients"
                    : "Satellit"}
              </h3>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Details schließen"
                onClick={() => setInspected(null)}
              >
                <XIcon size={15} />
              </Button>
            </header>
            {inspected === "clients" ? (
              <>
                <div className="network-inspector-name">Desktop &amp; Mobil</div>
                <p>
                  {devices === null
                    ? "Geräte wurden noch nicht bestätigt."
                    : `${devices.length} registrierte Geräte.`}
                </p>
                <h4>Aktuell verbunden</h4>
                <p>Benutzer und Live-Präsenz werden von dieser Instanz noch nicht gemeldet.</p>
              </>
            ) : (
              <>
                <div className="network-inspector-name">
                  {inspected === "master"
                    ? (host?.displayName ?? instanceHostLabel(instance))
                    : satelliteNodes?.find((node) => node.id === inspected)?.name}
                </div>
                <p>
                  {inspectedConnected
                    ? "Mit dieser App verbunden"
                    : "Computerverbindung nicht bestätigt"}
                </p>
                {inspected === "master" && (
                  <>
                    <h4>CTOX-Instanz</h4>
                    <p>Gemeinsamer Sync · Projekte · Aufgaben</p>
                    <p>Ops / Business OS · {instanceAppsLabel(apps)}</p>
                  </>
                )}
                <h4>Harnesses</h4>
                {inspectedConnected && inspectedComputer ? (
                  <ComputerHarnesses environmentId={inspectedComputer.environmentId} />
                ) : (
                  <p>Verfügbarkeit noch nicht geprüft.</p>
                )}
              </>
            )}
            <h4>Netzwerk</h4>
            <p>
              {assigned === null
                ? "Computerzuordnung noch nicht bestätigt."
                : `${satelliteNodes?.length ?? 0} Satelliten zugeordnet.`}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-4"
              onClick={() => setRevision((value) => value + 1)}
            >
              Netzwerk prüfen
            </Button>
          </aside>
        )}
      </div>
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
    <section aria-label="Dein Workjet-Netzwerk">
      {instances.length === 0 ? (
        <NetworkDiagram
          name="Erstes Netzwerk"
          host=""
          ready={false}
          satellites={[]}
          registeredClients={null}
          selected={null}
          empty
          onInspect={() => {}}
          onAdd={() => openInstanceSetup()}
        />
      ) : (
        instances.map((instance) => (
          <InstanceNode key={instance.id} instance={instance} onSelect={onSelect} />
        ))
      )}
      {instances.length > 0 && (
        <button type="button" className="network-new-instance" onClick={() => openInstanceSetup()}>
          <PlusIcon size={18} />
          Weitere Instanz hinzufügen
        </button>
      )}
    </section>
  );
}
