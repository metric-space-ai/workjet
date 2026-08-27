import type {
  CtoxDiscoveryResult,
  CtoxManagedInstance,
  DesktopCtoxBridge,
  WorkjetDeviceBindingSummary,
} from "@t3tools/contracts";
import {
  BriefcaseBusinessIcon,
  CircleAlertIcon,
  LaptopIcon,
  PlusIcon,
  RefreshCwIcon,
  SmartphoneIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";

import type { CrossModeTarget } from "../../crossMode/crossModeTarget";
import { crossModeSelectionMemory } from "../../crossMode/crossModeSelectionMemory";
import { usePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type BusinessOsDiscovery = "loading" | CtoxDiscoveryResult;

/** SSH-managed hosts are computers inside a Business OS, never Business-OS instances. */
export function visibleBusinessOsInstances(
  discovery: BusinessOsDiscovery,
): readonly CtoxManagedInstance[] {
  if (discovery === "loading" || discovery._tag !== "ready") return [];
  return discovery.instances
    .filter((instance) => instance.source !== "ssh_managed")
    .toSorted((left, right) => left.displayName.localeCompare(right.displayName));
}

export function resolveActiveBusinessOsInstanceId(target: CrossModeTarget | null): string | null {
  return target?.mode === "business-os" && target.ctoxInstanceId !== undefined
    ? target.ctoxInstanceId
    : null;
}

function instanceStatus(instance: CtoxManagedInstance): string {
  if (instance.status === "available" || instance.status === "paired") {
    return instance.healthSummary.dataPlaneReady
      ? "Verbunden und synchron"
      : "Verbunden, Synchronisierung beeinträchtigt";
  }
  if (instance.status === "needs_auth") return "Anmeldung erforderlich";
  if (instance.status === "pairing_expired") return "Gerätefreigabe abgelaufen";
  if (instance.status === "offline") return "Nicht erreichbar";
  if (instance.status === "installing") return "Wird eingerichtet";
  return "Verbindung fehlerhaft";
}

export function BusinessOsSettingsView({
  instances,
  activeInstanceId,
  loading = false,
  refreshDisabled = false,
  addDisabledReason = null,
  computerCount = 0,
  devices = [],
  devicesLoading = false,
  devicesError = null,
  deviceManagementBlockedReason = null,
  onSelectInstance,
  onRefresh,
  onAddBusinessOs,
  onAddDevice,
  onRevokeDevice,
  revokingDeviceId = null,
}: {
  readonly instances: readonly CtoxManagedInstance[];
  readonly activeInstanceId: string | null;
  readonly loading?: boolean;
  readonly refreshDisabled?: boolean;
  readonly addDisabledReason?: string | null;
  readonly computerCount?: number;
  readonly devices?: readonly WorkjetDeviceBindingSummary[];
  readonly devicesLoading?: boolean;
  readonly devicesError?: string | null;
  readonly deviceManagementBlockedReason?: string | null;
  readonly onSelectInstance?: (instanceId: string) => void;
  readonly onRefresh?: () => void;
  readonly onAddBusinessOs?: (invite: string) => Promise<string | null>;
  readonly onAddDevice?: () => void;
  readonly onRevokeDevice?: (devicePairingId: string) => void;
  readonly revokingDeviceId?: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [invite, setInvite] = useState("");
  const [addingError, setAddingError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selected = instances.find((instance) => instance.id === activeInstanceId) ?? null;

  const submitInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (onAddBusinessOs === undefined) return;
    setAddingError(null);
    setSubmitting(true);
    void onAddBusinessOs(invite)
      .then((error) => {
        if (error !== null) {
          setAddingError(error);
          return;
        }
        setInvite("");
        setAdding(false);
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <SettingsPageContainer className="gap-6">
      <div className="px-3 sm:px-4">
        <h1 className="text-xl font-semibold tracking-[-0.025em]">Business OS</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Wähle die Business-OS-Instanz, die Code und Business OS gemeinsam verwenden. Ein
          Moduswechsel ändert diese Auswahl nicht.
        </p>
      </div>

      <SettingsSection
        title="Business-OS-Instanz"
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onRefresh}
              disabled={refreshDisabled || onRefresh === undefined}
            >
              <RefreshCwIcon className={loading ? "animate-spin" : undefined} aria-hidden />
              Aktualisieren
            </Button>
            <Button size="sm" onClick={() => setAdding((current) => !current)}>
              <PlusIcon aria-hidden />
              Business OS hinzufügen
            </Button>
          </div>
        }
      >
        <div className="max-w-2xl rounded-lg border border-border bg-muted/10 p-4">
          {loading ? (
            <p className="text-sm text-muted-foreground" role="status">
              Business-OS-Instanzen werden geladen …
            </p>
          ) : instances.length === 0 ? (
            <div className="flex items-start gap-3" role="status">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div>
                <p className="text-sm font-medium">Keine Business-OS-Instanz verbunden</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Füge eine Business-OS-Instanz über eine sichere Backend-Einladung hinzu.
                </p>
              </div>
            </div>
          ) : (
            <label className="block text-sm font-medium text-foreground">
              Aktive Instanz
              <select
                className="mt-2 h-10 w-full rounded-md border border-input bg-popover px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={selected?.id ?? ""}
                onChange={(event) => onSelectInstance?.(event.target.value)}
                aria-label="Aktive Business-OS-Instanz"
              >
                {selected === null ? <option value="">Instanz auswählen</option> : null}
                {instances.map((instance) => (
                  <option key={instance.id} value={instance.id}>
                    {instance.displayName}
                  </option>
                ))}
              </select>
              {selected === null ? null : (
                <span className="mt-2 flex items-center gap-2 text-sm font-normal text-muted-foreground">
                  <BriefcaseBusinessIcon className="size-4" aria-hidden />
                  {instanceStatus(selected)}
                  {selected.domain === undefined ? null : ` · ${selected.domain}`}
                </span>
              )}
            </label>
          )}

          {adding ? (
            <form className="mt-4 border-t border-border pt-4" onSubmit={submitInvite}>
              <label className="block text-sm font-medium">
                Backend-Einladung
                <textarea
                  className="mt-2 min-h-24 w-full resize-y rounded-md border border-input bg-popover p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={invite}
                  onChange={(event) => setInvite(event.target.value)}
                  autoComplete="off"
                  maxLength={65_536}
                  required
                  aria-describedby="business-os-add-help"
                />
              </label>
              <p id="business-os-add-help" className="mt-2 text-xs text-muted-foreground">
                Fügt eine echte CTOX-Backend-Instanz hinzu. SSH-Rechner werden unter Computers
                eingerichtet und erscheinen hier nicht als eigene Business OS.
              </p>
              {addDisabledReason === null ? null : (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {addDisabledReason}
                </p>
              )}
              {addingError === null ? null : (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {addingError}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <Button type="submit" size="sm" disabled={submitting || addDisabledReason !== null}>
                  {submitting ? "Wird hinzugefügt …" : "Einladung verwenden"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
                  Abbrechen
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection title="Workjet-Geräte">
        <div className="max-w-2xl rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <SmartphoneIcon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <div>
                <p className="text-sm font-medium">
                  {selected === null ? "Instanz auswählen" : `Geräte für ${selected.displayName}`}
                </p>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  {selected === null
                    ? "Wähle zuerst die Business-OS-Instanz, für die ein Workjet-Gerät freigegeben werden soll."
                    : "Gerätefreigaben werden nach der serverautoritativen Zuordnung hier mit Ablauf und Widerruf angezeigt."}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              disabled={
                selected === null ||
                onAddDevice === undefined ||
                deviceManagementBlockedReason !== null
              }
              onClick={onAddDevice}
              title={deviceManagementBlockedReason ?? undefined}
            >
              <PlusIcon aria-hidden />
              Gerät hinzufügen
            </Button>
          </div>
          {selected === null ? null : deviceManagementBlockedReason !== null ? (
            <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-muted-foreground">
              {deviceManagementBlockedReason}
            </p>
          ) : devicesLoading ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Spinner className="size-3.5" /> Geräte werden geladen …
            </p>
          ) : devicesError !== null ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {devicesError}
            </p>
          ) : devices.length === 0 ? (
            <p className="mt-3 rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Noch keine weiteren Workjet-Geräte mit dieser Instanz verbunden.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border rounded-md border border-border">
              {devices.map((device) => (
                <li
                  key={device.devicePairingId}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      Workjet-Gerät · {device.deviceId.slice(-8)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Verbunden am {new Date(device.pairedAtMillis).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revokingDeviceId === device.devicePairingId}
                      onClick={() => onRevokeDevice?.(device.devicePairingId)}
                    >
                      {revokingDeviceId === device.devicePairingId ? (
                        <Spinner className="size-3.5" />
                      ) : null}
                      Widerrufen
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Rechner für Code">
        <div className="max-w-2xl rounded-lg border border-border p-4">
          <div className="flex items-start gap-3">
            <LaptopIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">
                {selected === null ? "Instanz auswählen" : `Zuweisungen zu ${selected.displayName}`}
              </p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                {computerCount === 0
                  ? "Im globalen Computer-Inventar sind noch keine Rechner eingerichtet."
                  : `${computerCount} Rechner im globalen Inventar. Die eindeutige Instanzzuordnung wird nach serverseitiger Freigabe hier verwaltet.`}
              </p>
              <a
                className="mt-3 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
                href="#/settings/computers"
              >
                Computer-Inventar öffnen
              </a>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Diagnose">
        <details className="max-w-2xl rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Technische Details
          </summary>
          {selected === null ? (
            <p className="mt-2 text-sm text-muted-foreground">Keine Instanz ausgewählt.</p>
          ) : (
            <div className="mt-2 space-y-1 break-all font-mono text-xs text-muted-foreground">
              <p>Darstellungs-ID: {selected.id}</p>
              <p>Quelle: {selected.source}</p>
              <p>Status: {selected.status}</p>
            </div>
          )}
        </details>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function useBusinessOsDiscovery(bridge: DesktopCtoxBridge | undefined) {
  const [discovery, setDiscovery] = useState<BusinessOsDiscovery>("loading");
  const refresh = useCallback(async () => {
    if (bridge === undefined) {
      setDiscovery({ _tag: "failed", code: "network_error" });
      return;
    }
    setDiscovery("loading");
    try {
      setDiscovery(await bridge.refresh());
    } catch {
      setDiscovery({ _tag: "failed", code: "network_error" });
    }
  }, [bridge]);
  useEffect(() => void refresh(), [refresh]);
  return { discovery, refresh };
}

export function BusinessOsSettings() {
  const settings = usePrimarySettings();
  const bridge = window.desktopBridge?.ctox;
  const { discovery, refresh } = useBusinessOsDiscovery(bridge);
  const instances = useMemo(() => visibleBusinessOsInstances(discovery), [discovery]);
  const activeInstanceId = useSyncExternalStore(
    crossModeSelectionMemory.subscribeToActiveCtoxInstance,
    () => resolveActiveBusinessOsInstanceId(crossModeSelectionMemory.read("business-os")),
    () => resolveActiveBusinessOsInstanceId(crossModeSelectionMemory.read("business-os")),
  );
  const [devices, setDevices] = useState<readonly WorkjetDeviceBindingSummary[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [authorityId, setAuthorityId] = useState<string | null>(null);
  const [authorityLoading, setAuthorityLoading] = useState(false);

  useEffect(() => {
    if (instances.length === 0) return;
    const next = instances.some((instance) => instance.id === activeInstanceId)
      ? activeInstanceId
      : (instances[0]?.id ?? null);
    if (next === null || next === activeInstanceId) return;
    crossModeSelectionMemory.remember({ mode: "business-os", ctoxInstanceId: next });
  }, [activeInstanceId, instances]);

  const selectInstance = (instanceId: string) => {
    if (!instances.some((instance) => instance.id === instanceId)) return;
    crossModeSelectionMemory.remember({ mode: "business-os", ctoxInstanceId: instanceId });
  };

  useEffect(() => {
    setAuthorityId(null);
    setDevices([]);
    setDevicesLoading(false);
    setDevicesError(null);
    if (activeInstanceId === null || bridge?.resolveInstanceAuthority === undefined) return;
    let cancelled = false;
    setAuthorityLoading(true);
    void bridge.resolveInstanceAuthority(activeInstanceId).then(
      (result) => {
        if (cancelled) return;
        setAuthorityLoading(false);
        setAuthorityId(result._tag === "completed" ? result.businessOsInstanceId : null);
      },
      () => {
        if (cancelled) return;
        setAuthorityLoading(false);
        setAuthorityId(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activeInstanceId, bridge]);

  const addBusinessOs = async (invite: string): Promise<string | null> => {
    if (bridge === undefined)
      return "Diese Workjet-Ausgabe kann keine Backend-Einladung importieren.";
    try {
      const result = await bridge.importInvite(invite);
      if (result._tag !== "completed") return "Die Backend-Einladung ist ungültig oder abgelaufen.";
      crossModeSelectionMemory.remember({
        mode: "business-os",
        ctoxInstanceId: result.instance.id,
      });
      await refresh();
      return null;
    } catch {
      return "Business OS konnte nicht hinzugefügt werden. Bitte Verbindung und Einladung prüfen.";
    }
  };

  const selected = instances.find((instance) => instance.id === activeInstanceId) ?? null;
  const deviceManagementBlockedReason =
    selected === null
      ? null
      : authorityLoading
        ? "Die Instanzberechtigung wird geprüft …"
        : authorityId === null
          ? "Die kanonische Instanzberechtigung konnte nicht bestätigt werden. Geräteaktionen bleiben aus Sicherheitsgründen gesperrt."
          : `Für ${selected.displayName} ist noch keine serverseitig attestierte Backend-Steuerverbindung verfügbar. Geräteaktionen bleiben bis dahin gesperrt.`;
  return (
    <BusinessOsSettingsView
      instances={instances}
      activeInstanceId={activeInstanceId}
      loading={discovery === "loading"}
      refreshDisabled={bridge === undefined}
      addDisabledReason={bridge === undefined ? "Nur in Workjet Desktop verfügbar." : null}
      computerCount={settings.workjet.computers.length}
      devices={devices}
      devicesLoading={devicesLoading}
      devicesError={devicesError}
      deviceManagementBlockedReason={deviceManagementBlockedReason}
      onSelectInstance={selectInstance}
      onRefresh={() => void refresh()}
      onAddBusinessOs={addBusinessOs}
    />
  );
}
