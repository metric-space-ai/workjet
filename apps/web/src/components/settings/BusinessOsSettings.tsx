import type {
  CtoxDiscoveryResult,
  CtoxManagedInstance,
  DesktopCtoxBridge,
  WorkjetDeviceBindingSummary,
  WorkjetManagedDeviceInviteManualConnectionResult,
} from "@workjet/contracts";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import type { CrossModeTarget } from "../../crossMode/crossModeTarget";
import {
  INSTANCES_SETTINGS_PATH,
  instanceAddRequestFromSearch,
  registerInstanceSetupNavigator,
  requestInstanceAdd,
} from "../../instanceSetup";
import { ctoxInstanceDisplayTitle } from "../ctox/ctoxInstanceDisplayTitle";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { InstanceAddInline } from "../ctox/InstanceAddInline";
import { InstanceNetworkOverview } from "../ctox/InstanceNetworkOverview";
import { Banner } from "../ui/banner";
import { Button } from "../ui/button";
import { InlinePanel } from "../ui/inline-panel";
import { QRCodeSvg } from "../ui/qr-code";
import { Row } from "../ui/row";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  businessOsDeviceControlErrorMessage,
  createBusinessOsDeviceInvite,
  type BusinessOsWebRtcDeviceInvite,
  listBusinessOsDevices,
  revokeBusinessOsDevice,
  revokeBusinessOsDeviceInvite,
} from "./businessOsDeviceControl";
import { encodeBusinessOsManualCredential } from "./businessOsManualCredential";
import { formatMobileInviteExpiry } from "./businessOsPairing";
import { dedupeCtoxInstances, InstancesTable } from "./InstancesTable";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type BusinessOsDiscovery = "loading" | CtoxDiscoveryResult;
const EMPTY_DEVICES: readonly WorkjetDeviceBindingSummary[] = [];

/** The instance registry contains actual CTOX backends, including those hosted over SSH. */
export function visibleBusinessOsInstances(
  discovery: BusinessOsDiscovery,
): readonly CtoxManagedInstance[] {
  if (discovery === "loading" || discovery._tag !== "ready") return [];
  return discovery.instances.toSorted((left, right) =>
    ctoxInstanceDisplayTitle(left).localeCompare(ctoxInstanceDisplayTitle(right)),
  );
}

export function resolveActiveBusinessOsInstanceId(target: CrossModeTarget | null): string | null {
  return target?.mode === "business-os" && target.ctoxInstanceId !== undefined
    ? target.ctoxInstanceId
    : null;
}

export function manualConnectionCredentialText(credential: string, visible: boolean): string {
  return visible ? credential : "••••••••••••";
}

function IconAction({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button aria-label={label} size="icon-sm" variant="ghost" onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

async function copyValue(value: string, sensitive = false) {
  await navigator.clipboard.writeText(value);
  if (!sensitive) return;
  window.setTimeout(() => {
    void navigator.clipboard
      .readText()
      .then((current) => (current === value ? navigator.clipboard.writeText("") : undefined))
      .catch(() => undefined);
  }, 30_000);
}

function ManualConnectionFields({
  connection,
}: {
  readonly connection: WorkjetManagedDeviceInviteManualConnectionResult;
}) {
  const [credentialVisible, setCredentialVisible] = useState(false);
  const credential = encodeBusinessOsManualCredential(connection);

  useEffect(() => {
    const hidePassword = () => {
      if (document.visibilityState !== "visible") setCredentialVisible(false);
    };
    document.addEventListener("visibilitychange", hidePassword);
    return () => document.removeEventListener("visibilitychange", hidePassword);
  }, []);

  const field = (label: string, value: string, actions: ReactNode) => (
    <div key={`${label}:${value}`} className="flex min-w-0 items-center gap-2">
      <dt className="w-32 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-1">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted/40 px-2 py-1 text-xs">
          {value}
        </code>
        {actions}
      </dd>
    </div>
  );

  return (
    <dl className="flex flex-col gap-1.5" data-workjet-device-manual-connection="">
      {connection.signalingUrls.map((url) =>
        field(
          "Server",
          url,
          <IconAction label="Server kopieren" onClick={() => void copyValue(url)}>
            <CopyIcon aria-hidden />
          </IconAction>,
        ),
      )}
      {field(
        "Raum",
        connection.room,
        <IconAction label="Raum kopieren" onClick={() => void copyValue(connection.room)}>
          <CopyIcon aria-hidden />
        </IconAction>,
      )}
      {field(
        "Verbindungspasswort",
        manualConnectionCredentialText(credential, credentialVisible),
        <>
          <IconAction
            label={credentialVisible ? "Passwort verbergen" : "Passwort zeigen"}
            onClick={() => setCredentialVisible((visible) => !visible)}
          >
            {credentialVisible ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
          </IconAction>
          <IconAction label="Passwort kopieren" onClick={() => void copyValue(credential, true)}>
            <CopyIcon aria-hidden />
          </IconAction>
        </>,
      )}
    </dl>
  );
}

/**
 * Gerät koppeln (QR für Telefone) inline auf der Seite, nie als Dialog.
 * Segment QR-Code | Verbindungsdaten, Fuß „Abbrechen“ (widerruft die
 * Einladung) und „Neuer QR-Code“.
 */
function DeviceInvitePanel({
  invite,
  onClose,
  onRenew,
  onLoadManualConnection,
  busy,
}: {
  readonly invite: BusinessOsWebRtcDeviceInvite;
  readonly onClose: () => void;
  readonly onRenew: () => void;
  readonly onLoadManualConnection:
    | (() => Promise<WorkjetManagedDeviceInviteManualConnectionResult>)
    | undefined;
  readonly busy: boolean;
}) {
  const [view, setView] = useState<"qr" | "manual">("qr");
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<WorkjetManagedDeviceInviteManualConnectionResult | null>(
    null,
  );
  const [manualState, setManualState] = useState<"idle" | "loading" | "failed">("idle");

  useEffect(() => {
    setCopied(false);
    setManual(null);
    setManualState("idle");
  }, [invite]);

  const loadManual = () => {
    if (manual !== null || manualState === "loading" || onLoadManualConnection === undefined)
      return;
    setManualState("loading");
    void onLoadManualConnection().then(
      (result) => {
        setManual(result);
        setManualState("idle");
      },
      () => setManualState("failed"),
    );
  };

  const status =
    manualState === "failed"
      ? "Verbindungsdaten nicht verfügbar."
      : `Gültig bis ${formatMobileInviteExpiry(invite.expiresAt, "de-DE")}`;

  let body: ReactNode = null;
  if (view === "qr") {
    body = (
      <div className="flex flex-wrap items-center gap-4">
        <div className="rounded-xl bg-white p-2 shadow-sm ring-1 ring-black/8">
          <QRCodeSvg
            value={invite.link}
            size={200}
            level="M"
            marginSize={2}
            title="QR-Code für das Gerät"
            className="size-44"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void copyValue(invite.link).then(() => setCopied(true));
          }}
        >
          <CopyIcon aria-hidden />
          {copied ? "Link kopiert" : "Link kopieren"}
        </Button>
      </div>
    );
  } else if (manual !== null) {
    body = <ManualConnectionFields connection={manual} />;
  } else if (manualState === "loading") {
    body = (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <Spinner className="size-3.5" /> Verbindungsdaten werden geladen …
      </p>
    );
  } else if (manualState === "failed") {
    body = (
      <div>
        <Button size="sm" variant="outline" onClick={loadManual}>
          Erneut versuchen
        </Button>
      </div>
    );
  }

  return (
    <InlinePanel
      triggerLabel="Gerät hinzufügen"
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      segment={
        <ToggleGroup
          aria-label="Art der Kopplung"
          size="sm"
          variant="outline"
          value={[view]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "qr" || next === "manual") {
              setView(next);
              if (next === "manual") loadManual();
            }
          }}
        >
          <Toggle value="qr">QR-Code</Toggle>
          <Toggle value="manual" disabled={onLoadManualConnection === undefined}>
            Verbindungsdaten
          </Toggle>
        </ToggleGroup>
      }
      submitLabel="Neuer QR-Code"
      onSubmit={onRenew}
      busy={busy}
      status={status}
      statusTone={manualState === "failed" ? "error" : "neutral"}
    >
      {body}
    </InlinePanel>
  );
}

function DevicesSection({
  instanceName,
  devices,
  devicesLoading,
  devicesError,
  blockedReason,
  onAddDevice,
  onRevokeDevice,
  onRetryDevices,
  addingDevice,
  activeInvite,
  onCloseInvite,
  onRenewInvite,
  onLoadManualConnection,
  renewingInvite,
}: {
  readonly instanceName: string;
  readonly devices: readonly WorkjetDeviceBindingSummary[];
  readonly devicesLoading: boolean;
  readonly devicesError: string | null;
  readonly blockedReason: string | null;
  readonly onAddDevice: (() => void) | undefined;
  readonly onRevokeDevice: ((devicePairingId: string) => void) | undefined;
  readonly onRetryDevices: (() => void) | undefined;
  readonly addingDevice: boolean;
  readonly activeInvite: BusinessOsWebRtcDeviceInvite | null;
  readonly onCloseInvite: (() => void) | undefined;
  readonly onRenewInvite: (() => void) | undefined;
  readonly onLoadManualConnection:
    | (() => Promise<WorkjetManagedDeviceInviteManualConnectionResult>)
    | undefined;
  readonly renewingInvite: boolean;
}) {
  return (
    <SettingsSection title={`Geräte · ${instanceName}`} data-workjet-instance-devices="">
      <div className="flex flex-col gap-2 px-3 sm:px-4">
        {blockedReason !== null ? (
          <Banner
            icon={CircleAlertIcon}
            {...(onRetryDevices === undefined
              ? {}
              : { action: { label: "Erneut prüfen", onClick: onRetryDevices } })}
          >
            {blockedReason}
          </Banner>
        ) : devicesLoading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Spinner className="size-3.5" /> Geräte werden geladen …
          </p>
        ) : devicesError !== null ? (
          <Banner
            icon={CircleAlertIcon}
            {...(onRetryDevices === undefined
              ? {}
              : { action: { label: "Erneut versuchen", onClick: onRetryDevices } })}
          >
            <span role="alert">{devicesError}</span>
          </Banner>
        ) : devices.length === 0 ? (
          <p className="text-xs text-muted-foreground">Keine weiteren Geräte</p>
        ) : (
          <ul aria-label="Geräte" className="divide-y divide-border/60 rounded-md border">
            {devices.map((device, index) => (
              <li key={device.devicePairingId}>
                <Row
                  name={`Gerät ${index + 1}`}
                  meta={`Gekoppelt am ${new Date(device.pairedAtMillis).toLocaleDateString("de-DE")}`}
                  status="ok"
                  statusLabel="Gekoppelt"
                  {...(onRevokeDevice === undefined
                    ? {}
                    : { onDelete: () => onRevokeDevice(device.devicePairingId) })}
                  deleteLabel="Trennen"
                  deleteConfirmTitle="Gerät trennen?"
                />
              </li>
            ))}
          </ul>
        )}
        {activeInvite !== null && onCloseInvite !== undefined && onRenewInvite !== undefined ? (
          <DeviceInvitePanel
            invite={activeInvite}
            onClose={onCloseInvite}
            onRenew={onRenewInvite}
            onLoadManualConnection={onLoadManualConnection}
            busy={renewingInvite}
          />
        ) : (
          <Button
            className="self-start"
            size="sm"
            variant="outline"
            disabled={onAddDevice === undefined || blockedReason !== null || addingDevice}
            onClick={onAddDevice}
          >
            {addingDevice ? <Spinner className="size-3.5" /> : null}
            {addingDevice ? "QR-Code wird erstellt …" : "Gerät hinzufügen"}
          </Button>
        )}
      </div>
    </SettingsSection>
  );
}

function NetworkSection({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-3" data-workjet-instance-network="">
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-8 w-full items-center gap-2 rounded-md px-3 text-left text-lg font-semibold tracking-[-0.025em] text-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon
          aria-hidden
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        Netzwerk
      </button>
      {open ? <div className="px-3 sm:px-4">{children}</div> : null}
    </section>
  );
}

export function BusinessOsSettingsView({
  instances,
  activeInstanceId,
  loading = false,
  discoveryFailed = false,
  refreshDisabled = false,
  devices = EMPTY_DEVICES,
  devicesLoading = false,
  devicesError = null,
  deviceManagementBlockedReason = null,
  onSelectInstance,
  onRefresh,
  onAddDevice,
  onRevokeDevice,
  onRetryDevices,
  addingDevice = false,
  activeInvite = null,
  onCloseInvite,
  onRenewInvite,
  onLoadManualConnection,
  renewingInvite = false,
  onStateChange,
  addPanel = null,
  network = null,
}: {
  readonly instances: readonly CtoxManagedInstance[];
  readonly activeInstanceId: string | null;
  readonly loading?: boolean;
  readonly discoveryFailed?: boolean;
  readonly refreshDisabled?: boolean;
  readonly devices?: readonly WorkjetDeviceBindingSummary[];
  readonly devicesLoading?: boolean;
  readonly devicesError?: string | null;
  readonly deviceManagementBlockedReason?: string | null;
  readonly onSelectInstance?: (instanceId: string) => void | Promise<boolean>;
  readonly onStateChange?: (
    instance: CtoxManagedInstance,
    state: "enabled" | "disabled" | "removed",
  ) => Promise<string | null>;
  readonly onRefresh?: () => void;
  readonly onAddDevice?: () => void;
  readonly onRevokeDevice?: (devicePairingId: string) => void;
  readonly onRetryDevices?: () => void;
  readonly addingDevice?: boolean;
  readonly activeInvite?: BusinessOsWebRtcDeviceInvite | null;
  readonly onCloseInvite?: () => void;
  readonly onRenewInvite?: () => void;
  readonly onLoadManualConnection?: () => Promise<WorkjetManagedDeviceInviteManualConnectionResult>;
  readonly renewingInvite?: boolean;
  /** Das Inline-Panel „Instanz hinzufügen“ (braucht den CTOX-Kontext). */
  readonly addPanel?: ReactNode;
  /** Inhalt des aufklappbaren Abschnitts „Netzwerk“. */
  readonly network?: ReactNode;
}) {
  const selected = instances.find((instance) => instance.id === activeInstanceId) ?? null;
  const visibleCount = instances.filter((instance) => instance.workjetState !== "removed").length;
  return (
    <SettingsPageContainer className="gap-5">
      <SettingsSection
        title="Instanzen"
        headerAction={
          <IconAction
            label="Aktualisieren"
            onClick={() => {
              if (!refreshDisabled) onRefresh?.();
            }}
          >
            <RefreshCwIcon className={loading ? "animate-spin" : undefined} aria-hidden />
          </IconAction>
        }
      >
        {loading ? (
          <p
            className="flex items-center gap-2 px-3 text-xs text-muted-foreground sm:px-4"
            role="status"
          >
            <Spinner className="size-3.5" /> Instanzen werden geladen …
          </p>
        ) : discoveryFailed ? (
          <div className="px-3 sm:px-4">
            <Banner
              icon={CircleAlertIcon}
              {...(onRefresh === undefined
                ? {}
                : { action: { label: "Erneut versuchen", onClick: onRefresh } })}
            >
              <span role="alert">Instanzen nicht erreichbar</span>
            </Banner>
          </div>
        ) : visibleCount === 0 ? (
          <p className="px-3 text-[13.5px] font-medium sm:px-4" role="status">
            Keine Instanz verbunden
          </p>
        ) : (
          <InstancesTable
            instances={instances}
            activeInstanceId={activeInstanceId}
            onSelect={onSelectInstance}
            onStateChange={onStateChange}
          />
        )}
        {addPanel === null ? null : (
          <div className="flex flex-col px-3 pt-2 sm:px-4">{addPanel}</div>
        )}
      </SettingsSection>

      {selected === null ? null : (
        <DevicesSection
          instanceName={ctoxInstanceDisplayTitle(selected)}
          devices={devices}
          devicesLoading={devicesLoading}
          devicesError={devicesError}
          blockedReason={deviceManagementBlockedReason}
          onAddDevice={onAddDevice}
          onRevokeDevice={onRevokeDevice}
          onRetryDevices={onRetryDevices}
          addingDevice={addingDevice}
          activeInvite={activeInvite}
          onCloseInvite={onCloseInvite}
          onRenewInvite={onRenewInvite}
          onLoadManualConnection={onLoadManualConnection}
          renewingInvite={renewingInvite}
        />
      )}

      {network === null || visibleCount === 0 ? null : <NetworkSection>{network}</NetworkSection>}
    </SettingsPageContainer>
  );
}

export async function importBusinessOsSettingsInvite(
  bridge: Pick<DesktopCtoxBridge, "importInvite"> | undefined,
  invite: string,
  select: (instance: CtoxManagedInstance) => void,
  refresh: () => void,
): Promise<string | null> {
  if (bridge === undefined) return "Einladungen nur in der Desktop-App.";
  try {
    const result = await bridge.importInvite(invite);
    if (result._tag !== "completed") return "Einladung ungültig oder abgelaufen.";
    select(result.instance);
    refresh();
    return null;
  } catch {
    return "Instanz konnte nicht hinzugefügt werden.";
  }
}

/**
 * Deep-Link `workjet://pair?payload=…` (Desktop) und Suchparameter
 * `?add=…`: Panel öffnen, Einladungslink vorbelegen, Parameter aus der
 * Adresse entfernen. Importiert wird erst nach „Hinzufügen“.
 */
function useInstanceAddFromLocation() {
  const navigate = useNavigate();
  const search = useLocation({
    select: (location) => (location as { search?: Readonly<Record<string, unknown>> }).search,
  });
  useEffect(
    () => registerInstanceSetupNavigator((path) => void navigate({ to: path })),
    [navigate],
  );
  useEffect(() => {
    const request = instanceAddRequestFromSearch(search);
    if (request === null) return;
    requestInstanceAdd(
      request.option,
      request.invite === undefined ? {} : { invite: request.invite },
    );
    void navigate({ to: INSTANCES_SETTINGS_PATH, search: {}, replace: true });
  }, [navigate, search]);
}

export function BusinessOsSettings() {
  useInstanceAddFromLocation();
  const {
    bridge,
    discovery,
    refresh,
    refreshing,
    selectedId: activeInstanceId,
    select,
    setInstanceState,
  } = useCtoxMode();
  const instances = useMemo(() => visibleBusinessOsInstances(discovery), [discovery]);
  const [devices, setDevices] = useState<readonly WorkjetDeviceBindingSummary[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [deviceRefreshKey, setDeviceRefreshKey] = useState(0);
  const [addingDevice, setAddingDevice] = useState(false);
  const [activeInvite, setActiveInvite] = useState<BusinessOsWebRtcDeviceInvite | null>(null);
  const [renewingInvite, setRenewingInvite] = useState(false);
  const deviceControlAvailable =
    activeInstanceId !== null && bridge?.requestDeviceControl !== undefined;

  const selectInstance = async (instanceId: string) => {
    const instance = instances.find((candidate) => candidate.id === instanceId);
    return instance !== undefined && (await select(instance));
  };

  const changeInstanceState = async (
    instance: CtoxManagedInstance,
    state: "enabled" | "disabled" | "removed",
  ): Promise<string | null> => {
    const result = await setInstanceState(instance, state);
    return result.ok ? null : "Änderung nicht gespeichert. Bitte erneut versuchen.";
  };

  useEffect(() => {
    setDevices([]);
    setDevicesError(null);
    if (!deviceControlAvailable || activeInstanceId === null || bridge === undefined) return;
    let cancelled = false;
    setDevicesLoading(true);
    void listBusinessOsDevices(bridge, activeInstanceId, activeInstanceId).then(
      (result) => {
        if (cancelled) return;
        setDevices(result.devices);
        setDevicesError(null);
        setDevicesLoading(false);
      },
      (error) => {
        if (cancelled) return;
        setDevices([]);
        setDevicesError(
          businessOsDeviceControlErrorMessage(error, "Geräteverbindung noch nicht verfügbar."),
        );
        setDevicesLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activeInstanceId, bridge, deviceControlAvailable, deviceRefreshKey]);

  const selected = instances.find((instance) => instance.id === activeInstanceId) ?? null;
  const deviceManagementBlockedReason =
    selected === null || deviceControlAvailable
      ? null
      : `${ctoxInstanceDisplayTitle(selected)} zuerst einmal in Ops öffnen.`;

  const createDeviceInvite = async () => {
    if (activeInstanceId === null || bridge === undefined || selected === null) return;
    setAddingDevice(true);
    setDevicesError(null);
    try {
      setActiveInvite(
        await createBusinessOsDeviceInvite(
          bridge,
          activeInstanceId,
          ctoxInstanceDisplayTitle(selected),
        ),
      );
    } catch (error) {
      setDevicesError(
        businessOsDeviceControlErrorMessage(error, "QR-Code konnte nicht erstellt werden."),
      );
    } finally {
      setAddingDevice(false);
    }
  };

  const closeInvite = () => {
    if (activeInvite === null) return;
    const inviteToRevoke = activeInvite;
    setActiveInvite(null);
    if (activeInstanceId === null || bridge === undefined) return;
    void revokeBusinessOsDeviceInvite(bridge, activeInstanceId, inviteToRevoke.inviteId).catch(
      () => {
        setDevicesError("Einladung nicht widerrufen. Vor Weitergabe neuen QR-Code erstellen.");
      },
    );
  };

  const renewInvite = async () => {
    if (
      activeInstanceId === null ||
      bridge === undefined ||
      activeInvite === null ||
      selected === null
    )
      return;
    setRenewingInvite(true);
    try {
      await revokeBusinessOsDeviceInvite(bridge, activeInstanceId, activeInvite.inviteId);
      setActiveInvite(
        await createBusinessOsDeviceInvite(
          bridge,
          activeInstanceId,
          ctoxInstanceDisplayTitle(selected),
        ),
      );
    } catch (error) {
      setDevicesError(
        businessOsDeviceControlErrorMessage(error, "Kein neuer QR-Code. Bitte erneut versuchen."),
      );
    } finally {
      setRenewingInvite(false);
    }
  };

  const revokeDevice = async (devicePairingId: string) => {
    if (activeInstanceId === null || bridge === undefined) return;
    try {
      await revokeBusinessOsDevice(bridge, activeInstanceId, devicePairingId);
      setDeviceRefreshKey((key) => key + 1);
    } catch (error) {
      setDevicesError(
        businessOsDeviceControlErrorMessage(error, "Gerät nicht getrennt. Bitte erneut versuchen."),
      );
    }
  };

  return (
    <BusinessOsSettingsView
      instances={instances}
      activeInstanceId={activeInstanceId}
      loading={discovery === "loading"}
      discoveryFailed={
        bridge !== undefined && discovery !== "loading" && discovery._tag === "failed"
      }
      refreshDisabled={bridge === undefined || refreshing}
      devices={devices}
      devicesLoading={devicesLoading}
      devicesError={devicesError}
      deviceManagementBlockedReason={deviceManagementBlockedReason}
      onSelectInstance={selectInstance}
      onStateChange={changeInstanceState}
      onRefresh={() => void refresh()}
      {...(!deviceControlAvailable ? {} : { onAddDevice: () => void createDeviceInvite() })}
      addingDevice={addingDevice}
      onRetryDevices={() => setDeviceRefreshKey((key) => key + 1)}
      onRevokeDevice={(devicePairingId) => void revokeDevice(devicePairingId)}
      activeInvite={activeInvite}
      onCloseInvite={closeInvite}
      onRenewInvite={() => void renewInvite()}
      {...(!deviceControlAvailable || activeInvite === null
        ? {}
        : { onLoadManualConnection: async () => activeInvite.manualConnection })}
      renewingInvite={renewingInvite}
      addPanel={<InstanceAddInline />}
      network={
        <InstanceNetworkOverview
          variant="section"
          instances={dedupeCtoxInstances(
            instances.filter((instance) => instance.workjetState !== "removed"),
            activeInstanceId,
          )}
          onSelect={(instance) => void select(instance)}
        />
      }
    />
  );
}
