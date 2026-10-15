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

/** Ort der Instanz; ohne gemeldeten Wert fällt er samt Beschriftung weg (D27). */
export function instanceHostLabel(instance: CtoxManagedInstance): string | null {
  if (instance.source === "local_daemon") return "Dieser Rechner";
  if (instance.domain) return instance.domain;
  if (instance.source === "ctox_dev") return "ctox.dev";
  return null;
}

/** Anzahl der Apps; ungeprüft fällt die Zeile weg (D27). */
export function instanceAppsLabel(result: CtoxInstanceAppsResult | null): string | null {
  if (result === null || result._tag !== "completed") return null;
  if (result.source === "cache" && result.apps.length === 0) return null;
  return `${result.apps.length} Apps`;
}

function ComputerHarnesses({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    serverEnvironment.workjetHarnessInspect({ environmentId, input: {} }),
  );
  if (query.error || !query.data || query.data.harnesses.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 text-xs">
      <h4>Harness</h4>
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
  const { bridge, appRailVersion, refresh, refreshing } = useCtoxMode();
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
  const needsRePair =
    (instance.source === "pairing_invite" || instance.source === "manual_pairing") &&
    instance.status === "error";
  const appsLabel = instanceAppsLabel(apps);
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
  // D31: Ist dieses Gerät schon als Rechner der Instanz da, steht es nur einmal im Netz.
  const thisDeviceIsComputer = rows.some(
    ({ computer }) => computer !== null && computer.environmentId === primaryEnvironmentId,
  );
  const clientNodes: NetworkClientNode[] = [
    ...(thisDeviceIsComputer
      ? []
      : [
          {
            id: "this-device",
            name:
              computers.find((computer) => computer.environmentId === primaryEnvironmentId)
                ?.label ?? "Workjet",
            kind: "this-device" as const,
            connected: instance.healthSummary.dataPlaneReady,
          },
        ]),
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
          {instance.source === "local_daemon" || instance.domain ? (
            <span>{instance.source === "local_daemon" ? "Lokal" : instance.domain}</span>
          ) : null}
        </div>
        {/* D29: Knöpfe sind Aktionen; „nicht erreichbar“ wird „Erneut verbinden“. */}
        {needsRePair ? (
          <Button size="sm" variant="outline" onClick={() => openInstanceRePair(instance)}>
            Neu koppeln
          </Button>
        ) : available ? (
          <Button size="sm" variant="outline" onClick={() => onSelect(instance)}>
            Instanz auswählen
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={refreshing}
            onClick={() => {
              refresh();
              setRevision((value) => value + 1);
            }}
          >
            Erneut verbinden
          </Button>
        )}
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
              <h3>{inspected === "master" ? "Instanz" : inspectedClient ? "Gerät" : "Rechner"}</h3>
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
                <div className="network-inspector-name">
                  {instanceHostLabel(instance) ?? ctoxInstanceDisplayTitle(instance)}
                </div>
                <p>{instance.healthSummary.dataPlaneReady ? "Verbunden" : "Getrennt"}</p>
                {appsLabel !== null ? <p>{appsLabel}</p> : null}
              </>
            ) : inspectedClient ? (
              <>
                <div className="network-inspector-name">{inspectedClient.name}</div>
                <p>{inspectedClient.connected ? "Verbunden" : "Getrennt"}</p>
              </>
            ) : (
              <>
                {inspectedNode ? (
                  <div className="network-inspector-name">{inspectedNode.name}</div>
                ) : null}
                <p>{inspectedNode?.connected ? "Verbunden" : "Getrennt"}</p>
                {inspectedNode?.connected && inspectedRow?.computer ? (
                  <ComputerHarnesses environmentId={inspectedRow.computer.environmentId} />
                ) : null}
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
          name="Instanz hinzufügen"
          host={null}
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
        <Button
          variant="outline"
          size="sm"
          className="network-new-instance"
          onClick={() => openInstanceSetup()}
        >
          <PlusIcon />
          Instanz hinzufügen
        </Button>
      )}
    </section>
  );
}
