import { useEffect, useState, useSyncExternalStore } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { NetworkDiagram } from "./NetworkDiagram";
import {
  networkCapabilityTags,
  networkPlatform,
  type NetworkClientNode,
  type NetworkComputerNode,
} from "./networkTopology";
import type {
  CtoxInstanceAppsResult,
  CtoxManagedInstance,
  EnvironmentId,
  WorkjetComputer,
  WorkjetDeviceBindingSummary,
} from "@workjet/contracts";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
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
import {
  listBusinessOsDevices,
  workjetDeviceDisplayName,
} from "../settings/businessOsDeviceControl";
import { mergeComputerRows } from "../settings/WorkjetComputersSettings";
import { canActivateCtoxInstance, useCtoxMode } from "./CtoxModeShell";
import { ctoxInstanceDisplayTitle } from "./ctoxInstanceDisplayTitle";

export function instanceHostLabel(instance: CtoxManagedInstance): string {
  if (instance.source === "local_daemon") return "Dieser Rechner";
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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
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
  const isConnected = (computer: WorkjetComputer | null) =>
    computer !== null &&
    environments.some(
      (environment) =>
        environment.environmentId === computer.environmentId &&
        environment.connection.phase === "connected",
    );
  // Ein Knoten je registriertem Rechner der Instanz, auch der Rechner, auf
  // dem die Instanz selbst läuft. Lokale Erkennung ergänzt Plattform,
  // Fähigkeiten und Verbindung, wenn dieselbe Maschine hier eingerichtet ist.
  const rows = assigned ? mergeComputerRows(computers, assigned).filter((row) => row.native) : [];
  const computerNodes: NetworkComputerNode[] = rows.map(({ computer, native }) => ({
    id: native!.id,
    name: native!.displayName,
    platform: networkPlatform(
      computer?.metadata?.facts?.operatingSystem ?? native!.detectedFacts?.operatingSystem,
    ),
    connected: isConnected(computer),
    tags: networkCapabilityTags(computer?.metadata, native),
  }));
  const clientNodes: NetworkClientNode[] = [
    {
      id: "this-device",
      name:
        computers.find((computer) => computer.environmentId === primaryEnvironmentId)?.label ??
        "Workjet",
      kind: "this-device",
      connected: instance.healthSummary.dataPlaneReady,
    },
    // CTOX meldet für Kopplungen keine Lebendigkeit: getrennt, bis sie es tut.
    ...(devices ?? []).map((device) => ({
      id: `device:${device.devicePairingId}`,
      name: workjetDeviceDisplayName(device),
      kind: "device" as const,
      connected: false,
    })),
  ];
  const inspectedRow = rows.find((row) => row.native!.id === inspected) ?? null;
  const inspectedClient = clientNodes.find((client) => client.id === inspected) ?? null;
  const inspectedNode = computerNodes.find((node) => node.id === inspected) ?? null;
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
          host={instanceHostLabel(instance)}
          ready={instance.healthSummary.dataPlaneReady}
          clients={clientNodes}
          computers={computerNodes}
          selected={inspected}
          onInspect={setInspected}
          canAdd={available}
          onAdd={() => void navigate({ to: COMPUTERS_SETTINGS_PATH })}
        />
        {inspected !== null && (
          <aside className="network-inspector" aria-label="Knotendetails">
            <header className="network-inspector-header">
              <h3>{inspected === "master" ? "Instanz" : inspectedClient ? "Client" : "Rechner"}</h3>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Details schließen"
                onClick={() => setInspected(null)}
              >
                <XIcon size={15} />
              </Button>
            </header>
            {inspected === "master" ? (
              <>
                <div className="network-inspector-name">{instanceHostLabel(instance)}</div>
                <p>{instance.healthSummary.dataPlaneReady ? "Verbunden" : "Getrennt"}</p>
                <p>{instanceAppsLabel(apps)}</p>
              </>
            ) : inspectedClient ? (
              <>
                <div className="network-inspector-name">{inspectedClient.name}</div>
                <p>{inspectedClient.connected ? "Verbunden" : "Getrennt"}</p>
              </>
            ) : (
              <>
                <div className="network-inspector-name">{inspectedNode?.name ?? "—"}</div>
                <p>{inspectedNode?.connected ? "Verbunden" : "Getrennt"}</p>
                <h4>Harnesses</h4>
                {inspectedNode?.connected && inspectedRow?.computer ? (
                  <ComputerHarnesses environmentId={inspectedRow.computer.environmentId} />
                ) : (
                  <p>—</p>
                )}
              </>
            )}
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
          clients={[]}
          computers={[]}
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
