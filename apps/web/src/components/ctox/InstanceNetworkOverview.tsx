import { useEffect, useState, useSyncExternalStore } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
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
import {
  COMPUTERS_SETTINGS_PATH,
  openInstanceRePair,
  openInstanceSetup,
} from "../../instanceSetup";
import { Button } from "../ui/button";
import { workjetHarnessDisplayLabel } from "../settings/WorkjetWorkerEditor";
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
  if (query.error || !query.data) return <p className="mt-2 text-xs text-muted-foreground">—</p>;
  return (
    <div className="mt-2 space-y-1 text-xs">
      {query.data.harnesses.map((harness) => (
        <p key={harness.harness} className="text-muted-foreground">
          {workjetHarnessDisplayLabel(harness.harness)} ·{" "}
          {harness.availability === "available" ? "Einsatzbereit" : "Nicht einsatzbereit"}
        </p>
      ))}
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
  const navigate = useNavigate();
  const [membershipStore] = useState(createComputerMembershipStore);
  const membership = useSyncExternalStore(
    membershipStore.subscribe,
    membershipStore.getSnapshot,
    membershipStore.getSnapshot,
  );
  const [apps, setApps] = useState<CtoxInstanceAppsResult | null>(null);
  const [devices, setDevices] = useState<readonly WorkjetDeviceBindingSummary[] | null>(null);
  const [inspected, setInspected] = useState<string | null>(null);
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
          disabled={
            !available &&
            !(
              (instance.source === "pairing_invite" || instance.source === "manual_pairing") &&
              instance.status === "error"
            )
          }
          onClick={() =>
            (instance.source === "pairing_invite" || instance.source === "manual_pairing") &&
            instance.status === "error"
              ? openInstanceRePair(instance)
              : onSelect(instance)
          }
        >
          {(instance.source === "pairing_invite" || instance.source === "manual_pairing") &&
          instance.status === "error"
            ? "Neu koppeln"
            : available
              ? "Instanz auswählen"
              : "Nicht erreichbar"}
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
          onAdd={() => void navigate({ to: COMPUTERS_SETTINGS_PATH })}
        />
        {inspected !== null && (
          <aside className="network-inspector" aria-label="Knotendetails">
            <header className="network-inspector-header">
              <h3>
                {inspected === "master"
                  ? "Zentralrechner"
                  : inspected === "clients"
                    ? "Geräte"
                    : "Rechner"}
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
                <p>{devices === null ? "—" : `${devices.length} Geräte`}</p>
              </>
            ) : (
              <>
                <div className="network-inspector-name">
                  {inspected === "master"
                    ? (host?.displayName ?? instanceHostLabel(instance))
                    : satelliteNodes?.find((node) => node.id === inspected)?.name}
                </div>
                <p>{inspectedConnected ? "Verbunden" : "Nicht bestätigt"}</p>
                {inspected === "master" && <p>{instanceAppsLabel(apps)}</p>}
                <h4>Harnesses</h4>
                {inspectedConnected && inspectedComputer ? (
                  <ComputerHarnesses environmentId={inspectedComputer.environmentId} />
                ) : (
                  <p>—</p>
                )}
              </>
            )}
            <h4>Netzwerk</h4>
            <p>{assigned === null ? "—" : `${satelliteNodes?.length ?? 0} Rechner`}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => setRevision((value) => value + 1)}
            >
              Netzwerk prüfen
            </Button>
          </aside>
        )}
      </div>
    </article>
  );
}

/**
 * Netzwerk-Topologie je Instanz. In Einstellungen › Instanzen ist sie ein
 * aufklappbarer Abschnitt (`variant="section"`): ohne eigenen Hinzufügen-
 * Knopf, denn die Seite hat ihr Inline-Panel. Rechner kommen aus
 * Einstellungen › Rechner, nie aus einem Dialog.
 */
export function InstanceNetworkOverview({
  instances,
  onSelect,
  variant = "home",
}: {
  readonly instances: readonly CtoxManagedInstance[];
  readonly onSelect: (instance: CtoxManagedInstance) => void;
  readonly variant?: "home" | "section";
}) {
  return (
    <section aria-label="Netzwerk" data-workjet-network-variant={variant}>
      {instances.length === 0 && variant === "section" ? null : instances.length === 0 ? (
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
      {instances.length > 0 && variant === "home" && (
        <button type="button" className="network-new-instance" onClick={() => openInstanceSetup()}>
          <PlusIcon size={18} />
          Instanz hinzufügen
        </button>
      )}
    </section>
  );
}
