import { openInstanceSetup } from "../../instanceSetup";
import { encodeBusinessOsManualCredential } from "./businessOsManualCredential";
import type {
  CtoxDiscoveryResult,
  CtoxManagedInstance,
  DesktopCtoxBridge,
  WorkjetDeviceBindingSummary,
  WorkjetManagedDeviceInviteManualConnectionResult,
} from "@workjet/contracts";
import {
  ArrowRightIcon,
  CircleAlertIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  UnplugIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import type { CrossModeTarget } from "../../crossMode/crossModeTarget";

import { ctoxInstanceDisplayTitle } from "../ctox/ctoxInstanceDisplayTitle";
import {
  canActivateCtoxInstance,
  isRemovableCtoxInstance,
  useCtoxMode,
} from "../ctox/CtoxModeShell";
import { INSTANCE_SETTINGS_NAV_ITEMS } from "./settingsNavigation";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import {
  businessOsDeviceControlErrorMessage,
  createBusinessOsDeviceInvite,
  type BusinessOsWebRtcDeviceInvite,
  listBusinessOsDevices,
  revokeBusinessOsDevice,
  revokeBusinessOsDeviceInvite,
} from "./businessOsDeviceControl";
import { formatMobileInviteExpiry } from "./businessOsPairing";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

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

export function manualConnectionCredentialText(credential: string, visible: boolean): string {
  return visible ? credential : "••••••••••••";
}

function DevicePairingDialog({
  instanceName,
  invite,
  onClose,
  onRenew,
  onRevoke,
  onLoadManualConnection,
  revoking,
}: {
  readonly instanceName: string | null;
  readonly invite: BusinessOsWebRtcDeviceInvite | null;
  readonly onClose: (() => void) | undefined;
  readonly onRenew: (() => void) | undefined;
  readonly onRevoke: (() => void) | undefined;
  readonly onLoadManualConnection:
    | (() => Promise<WorkjetManagedDeviceInviteManualConnectionResult>)
    | undefined;
  readonly revoking: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [manualConnection, setManualConnection] =
    useState<WorkjetManagedDeviceInviteManualConnectionResult | null>(null);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState(false);
  const [credentialVisible, setCredentialVisible] = useState(false);
  const link = invite?.link ?? null;

  useEffect(() => {
    setCopied(false);
    setManualConnection(null);
    setManualLoading(false);
    setManualError(false);
    setCredentialVisible(false);
  }, [invite]);

  useEffect(() => {
    const hidePassword = () => {
      if (document.visibilityState !== "visible") setCredentialVisible(false);
    };
    document.addEventListener("visibilitychange", hidePassword);
    return () => document.removeEventListener("visibilitychange", hidePassword);
  }, []);

  const copyValue = async (value: string, sensitive = false) => {
    await navigator.clipboard.writeText(value);
    if (!sensitive) return;
    window.setTimeout(() => {
      void navigator.clipboard
        .readText()
        .then((current) => (current === value ? navigator.clipboard.writeText("") : undefined))
        .catch(() => undefined);
    }, 30_000);
  };

  const loadManualConnection = () => {
    if (manualConnection !== null || manualLoading || onLoadManualConnection === undefined) {
      return;
    }
    setManualLoading(true);
    setManualError(false);
    void onLoadManualConnection().then(
      (result) => {
        setManualConnection(result);
        setManualLoading(false);
      },
      () => {
        setManualError(true);
        setManualLoading(false);
      },
    );
  };

  const close = () => {
    setCredentialVisible(false);
    setManualConnection(null);
    onClose?.();
  };

  return (
    <Dialog open={invite !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>Workjet-Gerät verbinden</DialogTitle>
          <DialogDescription>
            Scanne den QR-Code mit Workjet auf dem neuen Gerät. Code und Business OS werden
            gemeinsam mit {instanceName ?? "dieser Instanz"} verbunden.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col items-center gap-4">
          {link === null || invite === null ? null : (
            <>
              <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/8">
                <QRCodeSvg
                  value={link}
                  size={320}
                  level="M"
                  marginSize={4}
                  title={`QR-Code für ${instanceName ?? "Business OS"}`}
                  className="h-auto w-full max-w-80"
                />
              </div>
              <div className="w-full rounded-lg bg-muted/40 px-3 py-3 text-center">
                <p className="text-sm font-medium">{instanceName ?? "Business OS"}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Gültig bis {formatMobileInviteExpiry(invite.expiresAt, "de-DE")} Uhr
                </p>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  void copyValue(link).then(() => setCopied(true));
                }}
              >
                <CopyIcon aria-hidden />
                {copied ? "Link kopiert" : "Verbindungslink kopieren"}
              </Button>

              <details
                className="w-full rounded-xl border border-border/80 bg-muted/20"
                onToggle={(event) => {
                  if (event.currentTarget.open) loadManualConnection();
                  else setCredentialVisible(false);
                }}
              >
                <summary className="cursor-pointer px-3 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Manuelle Verbindungsdaten
                </summary>
                <div className="border-t border-border/70 px-3 py-3">
                  <p className="text-xs leading-5 text-muted-foreground">
                    Diese Daten verbinden nur die CTOX-Synchronisierung. Für die vollständige
                    Workjet-Verbindung mit Code und Business OS verwende den QR-Code oder den
                    Verbindungslink.
                  </p>
                  {manualLoading ? (
                    <p
                      className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"
                      role="status"
                    >
                      <Spinner className="size-3.5" /> Verbindungsdaten werden geladen …
                    </p>
                  ) : manualError ? (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-destructive" role="alert">
                        Die manuellen Verbindungsdaten konnten nicht geladen werden.
                      </p>
                      <Button size="sm" variant="outline" onClick={loadManualConnection}>
                        Erneut versuchen
                      </Button>
                    </div>
                  ) : manualConnection === null ? null : (
                    <dl className="mt-3 space-y-3">
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Server</dt>
                        {manualConnection.signalingUrls.map((url) => (
                          <dd key={url} className="mt-1 flex items-center gap-2">
                            <code className="min-w-0 flex-1 break-all rounded-md bg-background px-2 py-1.5 text-xs">
                              {url}
                            </code>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label="Server kopieren"
                              onClick={() => void copyValue(url)}
                            >
                              <CopyIcon aria-hidden />
                            </Button>
                          </dd>
                        ))}
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Raum</dt>
                        <dd className="mt-1 flex items-center gap-2">
                          <code className="min-w-0 flex-1 break-all rounded-md bg-background px-2 py-1.5 text-xs">
                            {manualConnection.room}
                          </code>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Raum kopieren"
                            onClick={() => void copyValue(manualConnection.room)}
                          >
                            <CopyIcon aria-hidden />
                          </Button>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Verbindungspasswort
                        </dt>
                        <dd className="mt-1 flex items-center gap-2">
                          <code className="min-w-0 flex-1 break-all rounded-md bg-background px-2 py-1.5 text-xs">
                            {manualConnectionCredentialText(
                              encodeBusinessOsManualCredential(manualConnection),
                              credentialVisible,
                            )}
                          </code>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={
                              credentialVisible
                                ? "Verbindungspasswort verbergen"
                                : "Verbindungspasswort anzeigen"
                            }
                            onClick={() => setCredentialVisible((visible) => !visible)}
                          >
                            {credentialVisible ? (
                              <EyeOffIcon aria-hidden />
                            ) : (
                              <EyeIcon aria-hidden />
                            )}
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Verbindungspasswort kopieren"
                            onClick={() =>
                              void copyValue(
                                encodeBusinessOsManualCredential(manualConnection),
                                true,
                              )
                            }
                          >
                            <CopyIcon aria-hidden />
                          </Button>
                        </dd>
                      </div>
                    </dl>
                  )}
                </div>
              </details>
            </>
          )}
        </DialogPanel>
        <DialogFooter className="sm:flex-wrap">
          <Button variant="ghost" onClick={close}>
            Schließen
          </Button>
          <Button variant="outline" onClick={onRenew} disabled={revoking}>
            Neuen QR-Code erstellen
          </Button>
          <Button variant="destructive" onClick={onRevoke} disabled={revoking}>
            {revoking ? <Spinner className="size-3.5" /> : null}
            Einladung widerrufen
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function BusinessOsSettingsView({
  instances,
  activeInstanceId,
  loading = false,
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
  revokingDeviceId = null,
  addingDevice = false,
  activeInvite = null,
  onCloseInvite,
  onRenewInvite,
  onRevokeInvite,
  onLoadManualConnection,
  revokingInvite = false,
  onRemoveInstance,
}: {
  readonly instances: readonly CtoxManagedInstance[];
  readonly activeInstanceId: string | null;
  readonly loading?: boolean;
  readonly refreshDisabled?: boolean;

  readonly devices?: readonly WorkjetDeviceBindingSummary[];
  readonly devicesLoading?: boolean;
  readonly devicesError?: string | null;
  readonly deviceManagementBlockedReason?: string | null;
  readonly onSelectInstance?: (instanceId: string) => void | Promise<boolean>;
  readonly onRemoveInstance?: (instance: CtoxManagedInstance) => Promise<string | null>;
  readonly onRefresh?: () => void;
  readonly onAddDevice?: () => void;
  readonly onRevokeDevice?: (devicePairingId: string) => void;
  readonly onRetryDevices?: () => void;
  readonly revokingDeviceId?: string | null;
  readonly addingDevice?: boolean;
  readonly activeInvite?: BusinessOsWebRtcDeviceInvite | null;
  readonly onCloseInvite?: () => void;
  readonly onRenewInvite?: () => void;
  readonly onRevokeInvite?: () => void;
  readonly onLoadManualConnection?: () => Promise<WorkjetManagedDeviceInviteManualConnectionResult>;
  readonly revokingInvite?: boolean;
}) {
  const selected = instances.find((instance) => instance.id === activeInstanceId) ?? null;
  const selectedDisplayName = selected === null ? null : ctoxInstanceDisplayTitle(selected);
  const navigate = useNavigate();
  const [switchingInstanceId, setSwitchingInstanceId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [removalTarget, setRemovalTarget] = useState<CtoxManagedInstance | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removalError, setRemovalError] = useState<string | null>(null);

  const chooseInstance = async (instance: CtoxManagedInstance) => {
    if (onSelectInstance === undefined) return;
    setSwitchingInstanceId(instance.id);
    setSelectionError(null);
    try {
      if ((await onSelectInstance(instance.id)) === false) {
        setSelectionError(
          "Der Instanzwechsel konnte nicht bestätigt werden. Bitte erneut versuchen.",
        );
      }
    } catch {
      setSelectionError("Die Instanz konnte nicht ausgewählt werden. Bitte erneut versuchen.");
    } finally {
      setSwitchingInstanceId(null);
    }
  };

  const confirmRemoval = async () => {
    if (removalTarget === null || onRemoveInstance === undefined) return;
    setRemoving(true);
    setRemovalError(null);
    try {
      const error = await onRemoveInstance(removalTarget);
      if (error === null) setRemovalTarget(null);
      else setRemovalError(error);
    } catch {
      setRemovalError("Die Verbindung konnte nicht entfernt werden. Bitte erneut versuchen.");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <SettingsPageContainer className="gap-6">
      <SettingsSection
        title="Instanzen"
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={onRefresh}
              disabled={refreshDisabled || onRefresh === undefined}
            >
              <RefreshCwIcon className={loading ? "animate-spin" : undefined} aria-hidden />
              Aktualisieren
            </Button>
            <Button size="sm" onClick={() => openInstanceSetup()}>
              <PlusIcon aria-hidden />
              Instanz hinzufügen
            </Button>
          </div>
        }
      >
        <p className="px-3 text-[13px] text-muted-foreground sm:px-4">
          Verwalte deine CTOX-Instanzen und öffne ihre Einstellungen.
        </p>
        <div>
          {loading ? (
            <p className="text-sm text-muted-foreground" role="status">
              CTOX-Instanzen werden geladen …
            </p>
          ) : instances.length === 0 ? (
            <div className="flex items-start gap-3" role="status">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div>
                <p className="text-sm font-medium">Keine CTOX-Instanz verbunden</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Verbinde einen vorhandenen CTOX-Master oder richte eine neue Instanz ein.
                </p>
              </div>
            </div>
          ) : (
            <ul aria-label="CTOX-Instanzen" className="divide-y divide-border/60">
              {instances.map((instance) => (
                <li key={instance.id}>
                  <SettingsRow
                    title={ctoxInstanceDisplayTitle(instance)}
                    description={
                      instance.domain ??
                      (instance.source === "local_daemon" ? "Dieser Computer" : undefined)
                    }
                    status={instanceStatus(instance)}
                    control={
                      <>
                        {instance.id === activeInstanceId ? (
                          <span
                            className="px-2 text-xs font-medium text-primary"
                            aria-label="Aktive Instanz"
                          >
                            Aktiv
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              onSelectInstance === undefined ||
                              switchingInstanceId !== null ||
                              removing ||
                              !canActivateCtoxInstance(instance)
                            }
                            onClick={() => void chooseInstance(instance)}
                          >
                            {switchingInstanceId === instance.id ? (
                              <Spinner className="size-3.5" />
                            ) : null}
                            {switchingInstanceId === instance.id
                              ? "Wird ausgewählt …"
                              : "Auswählen"}
                          </Button>
                        )}
                        {onRemoveInstance !== undefined && isRemovableCtoxInstance(instance) ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={switchingInstanceId !== null || removing}
                            aria-label={`Verbindung zu ${ctoxInstanceDisplayTitle(instance)} entfernen`}
                            onClick={() => {
                              setRemovalError(null);
                              setRemovalTarget(instance);
                            }}
                          >
                            <UnplugIcon aria-hidden />
                          </Button>
                        ) : null}
                      </>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          {selectionError === null ? null : (
            <p className="px-4 py-2 text-sm text-destructive" role="alert">
              {selectionError}
            </p>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={
          instances.length > 1 && selectedDisplayName !== null
            ? `Einstellungen für ${selectedDisplayName}`
            : "Einstellungen"
        }
      >
        {selected === null ? (
          <p className="px-3 text-sm text-muted-foreground sm:px-4" role="status">
            Wähle zuerst eine Instanz aus.
          </p>
        ) : (
          <div className="grid gap-1 sm:grid-cols-2">
            {INSTANCE_SETTINGS_NAV_ITEMS.map((item) => (
              <button
                key={item.to}
                type="button"
                className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
                onClick={() => void navigate({ to: item.to })}
              >
                <item.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            ))}
          </div>
        )}
      </SettingsSection>

      <details className="mx-3 border-t border-border/60 sm:mx-4" data-workjet-instance-devices="">
        <summary className="cursor-pointer py-3 text-sm font-medium">Verbundene Geräte</summary>
        <div className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <SmartphoneIcon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <div>
                <p className="text-sm font-medium">
                  {selectedDisplayName === null
                    ? "Instanz auswählen"
                    : `Geräte für ${selectedDisplayName}`}
                </p>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  {selected === null
                    ? "Wähle zuerst eine CTOX-Instanz."
                    : "Verbinde einen weiteren Computer, ein Smartphone oder Tablet mit dieser Instanz."}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              disabled={
                selected === null ||
                onAddDevice === undefined ||
                deviceManagementBlockedReason !== null ||
                addingDevice
              }
              onClick={onAddDevice}
              title={deviceManagementBlockedReason ?? undefined}
            >
              {addingDevice ? <Spinner className="size-3.5" /> : <PlusIcon aria-hidden />}
              {addingDevice ? "QR-Code wird erstellt …" : "Gerät hinzufügen"}
            </Button>
          </div>
          {selected === null ? null : deviceManagementBlockedReason !== null ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/35 px-3 py-3">
              <p className="text-sm text-muted-foreground">{deviceManagementBlockedReason}</p>
              {onRetryDevices === undefined ? null : (
                <Button size="sm" variant="outline" onClick={onRetryDevices}>
                  <RefreshCwIcon aria-hidden />
                  Erneut prüfen
                </Button>
              )}
            </div>
          ) : devicesLoading ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner className="size-3.5" /> Geräte werden geladen …
            </p>
          ) : devicesError !== null ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-3">
              <p className="text-sm text-destructive" role="alert">
                {devicesError}
              </p>
              {onRetryDevices === undefined ? null : (
                <Button size="sm" variant="outline" onClick={onRetryDevices}>
                  Erneut versuchen
                </Button>
              )}
            </div>
          ) : devices.length === 0 ? (
            <p className="mt-4 rounded-lg bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
              Mit dieser Instanz ist noch kein weiteres Workjet-Gerät verbunden.
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
      </details>

      <AlertDialog
        open={removalTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setRemovalTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Instanzverbindung entfernen?</AlertDialogTitle>
            <AlertDialogDescription>
              {removalTarget === null ? "" : ctoxInstanceDisplayTitle(removalTarget)} wird aus
              Workjet entfernt. Die Instanz und ihre Daten bleiben erhalten.
            </AlertDialogDescription>
            {removalError === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {removalError}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={removing} onClick={() => setRemovalTarget(null)}>
              Abbrechen
            </Button>
            <Button variant="destructive" disabled={removing} onClick={() => void confirmRemoval()}>
              {removing ? "Wird entfernt …" : "Verbindung entfernen"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <DevicePairingDialog
        instanceName={selectedDisplayName}
        invite={activeInvite}
        onClose={onCloseInvite}
        onRenew={onRenewInvite}
        onRevoke={onRevokeInvite}
        onLoadManualConnection={
          activeInvite === null || onLoadManualConnection === undefined
            ? undefined
            : onLoadManualConnection
        }
        revoking={revokingInvite}
      />
    </SettingsPageContainer>
  );
}

export async function importBusinessOsSettingsInvite(
  bridge: Pick<DesktopCtoxBridge, "importInvite"> | undefined,
  invite: string,
  select: (instance: CtoxManagedInstance) => void,
  refresh: () => void,
): Promise<string | null> {
  if (bridge === undefined)
    return "Diese Workjet-Ausgabe kann keine Backend-Einladung importieren.";
  try {
    const result = await bridge.importInvite(invite);
    if (result._tag !== "completed") return "Die Backend-Einladung ist ungültig oder abgelaufen.";
    select(result.instance);
    refresh();
    return null;
  } catch {
    return "Business OS konnte nicht hinzugefügt werden. Bitte Verbindung und Einladung prüfen.";
  }
}

export function BusinessOsSettings() {
  const {
    bridge,
    discovery,
    refresh,
    refreshing,
    selectedId: activeInstanceId,
    select,
    removePairedInstance,
    removeSshManagedInstance,
  } = useCtoxMode();
  const instances = useMemo(() => visibleBusinessOsInstances(discovery), [discovery]);
  const [devices, setDevices] = useState<readonly WorkjetDeviceBindingSummary[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [deviceRefreshKey, setDeviceRefreshKey] = useState(0);
  const [addingDevice, setAddingDevice] = useState(false);
  const [activeInvite, setActiveInvite] = useState<BusinessOsWebRtcDeviceInvite | null>(null);
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [revokingInvite, setRevokingInvite] = useState(false);
  const deviceControlAvailable =
    activeInstanceId !== null && bridge?.requestDeviceControl !== undefined;

  const selectInstance = async (instanceId: string) => {
    const instance = instances.find((candidate) => candidate.id === instanceId);
    return instance !== undefined && (await select(instance));
  };

  const removeInstance = async (instance: CtoxManagedInstance): Promise<string | null> => {
    const result = await (instance.source === "ssh_managed"
      ? removeSshManagedInstance(instance)
      : removePairedInstance(instance));
    return result.ok ? null : result.message;
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
          businessOsDeviceControlErrorMessage(
            error,
            "Die Geräteverbindung ist noch nicht verfügbar. Prüfe die Verbindung und versuche es erneut.",
          ),
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
    selected === null
      ? null
      : !deviceControlAvailable
        ? `Öffne ${ctoxInstanceDisplayTitle(selected)} einmal in Business OS, um ein Gerät über CTOX Sync zu verbinden.`
        : null;

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
        businessOsDeviceControlErrorMessage(
          error,
          "Der QR-Code konnte nicht erstellt werden. Die sichere Geräteverbindung ist derzeit nicht erreichbar.",
        ),
      );
    } finally {
      setAddingDevice(false);
    }
  };

  const revokeInvite = async () => {
    if (activeInstanceId === null || bridge === undefined || activeInvite === null) return;
    setRevokingInvite(true);
    try {
      await revokeBusinessOsDeviceInvite(bridge, activeInstanceId, activeInvite.inviteId);
      setActiveInvite(null);
    } catch (error) {
      setDevicesError(
        businessOsDeviceControlErrorMessage(
          error,
          "Die Einladung konnte nicht widerrufen werden. Bitte erneut versuchen.",
        ),
      );
    } finally {
      setRevokingInvite(false);
    }
  };

  const closeInvite = () => {
    if (activeInvite === null) return;
    const inviteToRevoke = activeInvite;
    setActiveInvite(null);
    if (activeInstanceId === null || bridge === undefined) return;
    void revokeBusinessOsDeviceInvite(bridge, activeInstanceId, inviteToRevoke.inviteId).catch(
      () => {
        setDevicesError(
          "Die geschlossene Einladung konnte nicht widerrufen werden. Erstelle vor der Weitergabe einen neuen QR-Code.",
        );
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
    setRevokingInvite(true);
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
        businessOsDeviceControlErrorMessage(
          error,
          "Es konnte kein neuer QR-Code erstellt werden. Bitte erneut versuchen.",
        ),
      );
    } finally {
      setRevokingInvite(false);
    }
  };

  const revokeDevice = async (devicePairingId: string) => {
    if (activeInstanceId === null || bridge === undefined) return;
    setRevokingDeviceId(devicePairingId);
    try {
      await revokeBusinessOsDevice(bridge, activeInstanceId, devicePairingId);
      setDeviceRefreshKey((key) => key + 1);
    } catch (error) {
      setDevicesError(
        businessOsDeviceControlErrorMessage(
          error,
          "Das Gerät konnte nicht getrennt werden. Bitte erneut versuchen.",
        ),
      );
    } finally {
      setRevokingDeviceId(null);
    }
  };

  return (
    <BusinessOsSettingsView
      instances={instances}
      activeInstanceId={activeInstanceId}
      loading={discovery === "loading"}
      refreshDisabled={bridge === undefined || refreshing}
      devices={devices}
      devicesLoading={devicesLoading}
      devicesError={devicesError}
      deviceManagementBlockedReason={deviceManagementBlockedReason}
      onSelectInstance={selectInstance}
      onRemoveInstance={removeInstance}
      onRefresh={() => void refresh()}
      {...(!deviceControlAvailable ? {} : { onAddDevice: () => void createDeviceInvite() })}
      addingDevice={addingDevice}
      onRetryDevices={() => setDeviceRefreshKey((key) => key + 1)}
      onRevokeDevice={(devicePairingId) => void revokeDevice(devicePairingId)}
      revokingDeviceId={revokingDeviceId}
      activeInvite={activeInvite}
      onCloseInvite={closeInvite}
      onRevokeInvite={() => void revokeInvite()}
      onRenewInvite={() => void renewInvite()}
      {...(!deviceControlAvailable || activeInvite === null
        ? {}
        : {
            onLoadManualConnection: async () => activeInvite.manualConnection,
          })}
      revokingInvite={revokingInvite}
    />
  );
}
