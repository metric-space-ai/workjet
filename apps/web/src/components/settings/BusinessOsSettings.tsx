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
  BriefcaseBusinessIcon,
  CircleAlertIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  LaptopIcon,
  PlusIcon,
  RefreshCwIcon,
  SmartphoneIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { CrossModeTarget } from "../../crossMode/crossModeTarget";

import { usePrimarySettings } from "../../hooks/useSettings";
import { ctoxInstanceDisplayTitle } from "../ctox/ctoxInstanceDisplayTitle";
import { CtoxInstanceSelectOption } from "../ctox/CtoxInstanceSelectOption";
import { CtoxSidebarShell, useCtoxMode } from "../ctox/CtoxModeShell";
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
  businessOsDeviceControlErrorMessage,
  createBusinessOsDeviceInvite,
  type BusinessOsWebRtcDeviceInvite,
  listBusinessOsDevices,
  revokeBusinessOsDevice,
  revokeBusinessOsDeviceInvite,
} from "./businessOsDeviceControl";
import { formatMobileInviteExpiry } from "./businessOsPairing";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type BusinessOsDiscovery = "loading" | CtoxDiscoveryResult;

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
                        <dt className="text-xs font-medium text-muted-foreground">Room</dt>
                        <dd className="mt-1 flex items-center gap-2">
                          <code className="min-w-0 flex-1 break-all rounded-md bg-background px-2 py-1.5 text-xs">
                            {manualConnection.room}
                          </code>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Copy room"
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
  loading = false,
  refreshDisabled = false,
  computerCount = 0,
  devices = [],
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
  connectionManagement,
}: {
  readonly instances: readonly CtoxManagedInstance[];
  readonly activeInstanceId: string | null;
  readonly loading?: boolean;
  readonly refreshDisabled?: boolean;
  readonly computerCount?: number;
  readonly devices?: readonly WorkjetDeviceBindingSummary[];
  readonly devicesLoading?: boolean;
  readonly devicesError?: string | null;
  readonly deviceManagementBlockedReason?: string | null;
  readonly onSelectInstance?: (instanceId: string) => void;
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
  readonly connectionManagement?: ReactNode;
}) {
  const selected = instances.find((instance) => instance.id === activeInstanceId) ?? null;
  const selectedDisplayName = selected === null ? null : ctoxInstanceDisplayTitle(selected);

  return (
    <SettingsPageContainer className="gap-6">
      <div className="px-3 sm:px-4">
        <h1 className="text-xl font-semibold tracking-[-0.025em]">Instances</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Each CTOX instance owns its network and serves Ops. Manage access to the selected instance
          here.
        </p>
      </div>

      <SettingsSection
        title="CTOX instances"
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
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
        <div className="max-w-3xl rounded-xl border border-border/80 bg-card/30 p-4 sm:p-5">
          {loading ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading CTOX instances …
            </p>
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
            <label className="block text-sm font-medium text-foreground">
              Active instance
              <select
                className="mt-2 h-10 w-full rounded-md border border-input bg-popover px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={selected?.id ?? ""}
                onChange={(event) => onSelectInstance?.(event.target.value)}
                aria-label="Select CTOX instance"
              >
                {selected === null ? <option value="">Select an instance</option> : null}
                {instances.map((instance) => (
                  <CtoxInstanceSelectOption key={instance.id} instance={instance} />
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
        </div>
      </SettingsSection>

      <SettingsSection title="Workjet devices">
        <div className="max-w-3xl rounded-xl border border-border/80 bg-card/20 p-4 sm:p-5">
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
      </SettingsSection>

      <SettingsSection title="Computers for Code">
        <div className="max-w-3xl rounded-xl border border-border/80 bg-card/20 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <LaptopIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">
                {selectedDisplayName === null
                  ? "Select an instance"
                  : `Assignments for ${selectedDisplayName}`}
              </p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                {computerCount === 0
                  ? "No computers have been set up in the global computer inventory."
                  : `${computerCount} computers are configured. Assign them to this CTOX instance in the computer inventory.`}
              </p>
              <a
                className="mt-3 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
                href="#/settings/computers"
              >
                Open computer inventory
              </a>
            </div>
          </div>
        </div>
      </SettingsSection>

      {connectionManagement}
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
  const settings = usePrimarySettings();
  const {
    bridge,
    discovery,
    refresh,
    refreshing,
    selectedId: activeInstanceId,
    select,
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

  const selectInstance = (instanceId: string) => {
    const instance = instances.find((candidate) => candidate.id === instanceId);
    if (instance !== undefined) select(instance);
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
      loading={discovery === "loading"}
      refreshDisabled={bridge === undefined || refreshing}
      computerCount={settings.workjet.computers.length}
      devices={devices}
      devicesLoading={devicesLoading}
      devicesError={devicesError}
      deviceManagementBlockedReason={deviceManagementBlockedReason}
      onSelectInstance={selectInstance}
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
      connectionManagement={
        <details data-workjet-instance-management="">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            Manage instance connections
          </summary>
          <CtoxSidebarShell showChrome={false} />
        </details>
      }
    />
  );
}
