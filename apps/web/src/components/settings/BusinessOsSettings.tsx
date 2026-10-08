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
      ? "Connected and synchronized"
      : "Connected, sync degraded";
  }
  if (instance.status === "needs_auth") return "Sign-in required";
  if (instance.status === "pairing_expired") return "Device authorization expired";
  if (instance.status === "offline") return "Unavailable";
  if (instance.status === "installing") return "Setting up";
  return "Connection failed";
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
          <DialogTitle>Connect a Workjet device</DialogTitle>
          <DialogDescription>
            Scan the QR code with Workjet on the new device. Code and Business OS will connect
            together to {instanceName ?? "this instance"}.
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
                  title={`QR code for ${instanceName ?? "Business OS"}`}
                  className="h-auto w-full max-w-80"
                />
              </div>
              <div className="w-full rounded-lg bg-muted/40 px-3 py-3 text-center">
                <p className="text-sm font-medium">{instanceName ?? "Business OS"}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Expires at {formatMobileInviteExpiry(invite.expiresAt, "en-US")}
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
                {copied ? "Link copied" : "Copy connection link"}
              </Button>

              <details
                className="w-full rounded-xl border border-border/80 bg-muted/20"
                onToggle={(event) => {
                  if (event.currentTarget.open) loadManualConnection();
                  else setCredentialVisible(false);
                }}
              >
                <summary className="cursor-pointer px-3 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Manual connection details
                </summary>
                <div className="border-t border-border/70 px-3 py-3">
                  <p className="text-xs leading-5 text-muted-foreground">
                    These details connect CTOX synchronization only. For the complete Workjet
                    connection with Code and Business OS, use the QR code or connection link.
                  </p>
                  {manualLoading ? (
                    <p
                      className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"
                      role="status"
                    >
                      <Spinner className="size-3.5" /> Loading connection details …
                    </p>
                  ) : manualError ? (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-destructive" role="alert">
                        Could not load manual connection details.
                      </p>
                      <Button size="sm" variant="outline" onClick={loadManualConnection}>
                        Try again
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
                              aria-label="Copy server"
                              onClick={() => void copyValue(url)}
                            >
                              <CopyIcon aria-hidden />
                            </Button>
                          </dd>
                        ))}
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Connection ID</dt>
                        <dd className="mt-1 flex items-center gap-2">
                          <code className="min-w-0 flex-1 break-all rounded-md bg-background px-2 py-1.5 text-xs">
                            {manualConnection.room}
                          </code>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Copy connection ID"
                            onClick={() => void copyValue(manualConnection.room)}
                          >
                            <CopyIcon aria-hidden />
                          </Button>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Connection password
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
                                ? "Hide connection password"
                                : "Show connection password"
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
                            aria-label="Copy connection password"
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
            Close
          </Button>
          <Button variant="outline" onClick={onRenew} disabled={revoking}>
            Create a new QR code
          </Button>
          <Button variant="destructive" onClick={onRevoke} disabled={revoking}>
            {revoking ? <Spinner className="size-3.5" /> : null}
            Revoke invitation
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function BusinessOsSettingsView({
  instances,
  activeInstanceId,
  requiresInstanceSelection = true,
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
  readonly requiresInstanceSelection?: boolean;
  readonly loading?: boolean;
  readonly discoveryFailed?: boolean;
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
        setSelectionError("The instance switch could not be confirmed. Please try again.");
      }
    } catch {
      setSelectionError("The instance could not be selected. Please try again.");
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
      setRemovalError("The connection could not be removed. Please try again.");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <SettingsPageContainer className="gap-6">
      <SettingsSection
        title="Instances"
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={onRefresh}
              disabled={refreshDisabled || onRefresh === undefined}
            >
              <RefreshCwIcon className={loading ? "animate-spin" : undefined} aria-hidden />
              Refresh
            </Button>
            <Button size="sm" onClick={() => openInstanceSetup()}>
              <PlusIcon aria-hidden />
              Add instance
            </Button>
          </div>
        }
      >
        <p className="px-3 text-[13px] text-muted-foreground sm:px-4">
          Manage your CTOX instances and open their settings.
        </p>
        <div>
          {loading ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading CTOX instances …
            </p>
          ) : discoveryFailed ? (
            <div className="flex items-start gap-3" role="alert">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div>
                <p className="text-sm font-medium">Could not load CTOX instances</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Check the connection and choose Refresh to try again.
                </p>
              </div>
            </div>
          ) : instances.length === 0 ? (
            <div className="flex items-start gap-3" role="status">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div>
                <p className="text-sm font-medium">No CTOX instance connected</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Connect an existing CTOX master or set up a new instance.
                </p>
              </div>
            </div>
          ) : (
            <ul aria-label="CTOX instances" className="divide-y divide-border/60">
              {instances.map((instance) => (
                <li key={instance.id}>
                  <SettingsRow
                    title={ctoxInstanceDisplayTitle(instance)}
                    description={
                      instance.domain ??
                      (instance.source === "local_daemon" ? "This computer" : undefined)
                    }
                    status={instanceStatus(instance)}
                    control={
                      <>
                        {instance.id === activeInstanceId ? (
                          <span
                            className="px-2 text-xs font-medium text-primary"
                            aria-label="Active instance"
                          >
                            Active
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
                            {switchingInstanceId === instance.id ? "Selecting …" : "Select"}
                          </Button>
                        )}
                        {onRemoveInstance !== undefined && isRemovableCtoxInstance(instance) ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={switchingInstanceId !== null || removing}
                            aria-label={`Remove connection to ${ctoxInstanceDisplayTitle(instance)}`}
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
            ? `Settings for ${selectedDisplayName}`
            : "Settings"
        }
      >
        {selected === null && requiresInstanceSelection ? (
          <p className="px-3 text-sm text-muted-foreground sm:px-4" role="status">
            Select an instance first.
          </p>
        ) : (
          <div className="grid gap-1 sm:grid-cols-2">
            {INSTANCE_SETTINGS_NAV_ITEMS.map((item) => (
              <button
                key={item.to}
                type="button"
                data-workjet-action={`instance-hub:${item.to}`}
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
        <summary className="cursor-pointer py-3 text-sm font-medium">Connected devices</summary>
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
                    ? "Select an instance"
                    : `Devices for ${selectedDisplayName}`}
                </p>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  {selected === null
                    ? "Select a CTOX instance first."
                    : "Connect another computer, phone or tablet to this instance."}
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
              {addingDevice ? "Creating QR code …" : "Add device"}
            </Button>
          </div>
          {selected === null ? null : deviceManagementBlockedReason !== null ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/35 px-3 py-3">
              <p className="text-sm text-muted-foreground">{deviceManagementBlockedReason}</p>
              {onRetryDevices === undefined ? null : (
                <Button size="sm" variant="outline" onClick={onRetryDevices}>
                  <RefreshCwIcon aria-hidden />
                  Check again
                </Button>
              )}
            </div>
          ) : devicesLoading ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner className="size-3.5" /> Loading devices …
            </p>
          ) : devicesError !== null ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-3">
              <p className="text-sm text-destructive" role="alert">
                {devicesError}
              </p>
              {onRetryDevices === undefined ? null : (
                <Button size="sm" variant="outline" onClick={onRetryDevices}>
                  Try again
                </Button>
              )}
            </div>
          ) : devices.length === 0 ? (
            <p className="mt-4 rounded-lg bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
              No other Workjet device is connected to this instance yet.
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
                      Workjet device · {device.deviceId.slice(-8)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Connected on {new Date(device.pairedAtMillis).toLocaleDateString()}
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
                      Revoke
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
            <AlertDialogTitle>Remove instance connection?</AlertDialogTitle>
            <AlertDialogDescription>
              {removalTarget === null ? "" : ctoxInstanceDisplayTitle(removalTarget)} will be
              removed from Workjet. The instance and its data will be preserved.
            </AlertDialogDescription>
            {removalError === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {removalError}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={removing} onClick={() => setRemovalTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={removing} onClick={() => void confirmRemoval()}>
              {removing ? "Removing …" : "Remove connection"}
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
  if (bridge === undefined) return "This Workjet edition cannot import a backend invitation.";
  try {
    const result = await bridge.importInvite(invite);
    if (result._tag !== "completed") return "The backend invitation is invalid or expired.";
    select(result.instance);
    refresh();
    return null;
  } catch {
    return "Business OS could not be added. Check the connection and invitation.";
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
            "Device connection is not available yet. Check the connection and try again.",
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
        ? `Open ${ctoxInstanceDisplayTitle(selected)} in Business OS once to connect a device through CTOX Sync.`
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
          "Could not create the QR code. The secure device connection is currently unavailable.",
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
          "Could not disconnect the device. Please try again.",
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
      requiresInstanceSelection={bridge !== undefined}
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
