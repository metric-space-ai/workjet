import type {
  CtoxDiscoveryResult,
  CtoxManagedInstance,
  DesktopCtoxBridge,
  WorkjetDeviceBindingV1,
  WorkjetDeviceInviteCreateResponseV1,
  WorkjetDeviceWebRtcRequestV1,
  WorkjetDeviceWebRtcResponseV1,
} from "@t3tools/contracts";
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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";

import type { CrossModeTarget } from "../../crossMode/crossModeTarget";
import { crossModeSelectionMemory } from "../../crossMode/crossModeSelectionMemory";
import { usePrimarySettings } from "../../hooks/useSettings";
import { ctoxInstanceDisplayTitle } from "../ctox/ctoxInstanceDisplayTitle";
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
import { encodeWorkjetBusinessOsPairingLink, formatMobileInviteExpiry } from "./businessOsPairing";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type BusinessOsDiscovery = "loading" | CtoxDiscoveryResult;

/** SSH-managed hosts are computers inside a Business OS, never Business-OS instances. */
export function visibleBusinessOsInstances(
  discovery: BusinessOsDiscovery,
): readonly CtoxManagedInstance[] {
  if (discovery === "loading" || discovery._tag !== "ready") return [];
  return discovery.instances
    .filter((instance) => instance.source !== "ssh_managed")
    .toSorted((left, right) =>
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

export function manualConnectionPasswordText(password: string, visible: boolean): string {
  return visible ? password : "••••••••••••";
}

function DevicePairingDialog({
  instanceName,
  invite,
  onClose,
  onRenew,
  onRevoke,
  revoking,
}: {
  readonly instanceName: string | null;
  readonly invite: WorkjetDeviceInviteCreateResponseV1 | null;
  readonly onClose: (() => void) | undefined;
  readonly onRenew: (() => void) | undefined;
  readonly onRevoke: (() => void) | undefined;
  readonly revoking: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const sensitiveClipboardValue = useRef<string | null>(null);
  const link = useMemo(
    () => (invite === null ? null : encodeWorkjetBusinessOsPairingLink(invite.invite)),
    [invite],
  );

  useEffect(() => {
    setCopied(false);
    setPasswordVisible(false);
  }, [invite]);

  const clearSensitiveClipboard = useCallback(() => {
    const value = sensitiveClipboardValue.current;
    sensitiveClipboardValue.current = null;
    if (value === null) return;
    void navigator.clipboard
      .readText()
      .then((current) => (current === value ? navigator.clipboard.writeText("") : undefined))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const discardInvite = () => {
      if (document.visibilityState === "visible") return;
      setPasswordVisible(false);
      clearSensitiveClipboard();
      onClose?.();
    };
    document.addEventListener("visibilitychange", discardInvite);
    return () => document.removeEventListener("visibilitychange", discardInvite);
  }, [clearSensitiveClipboard, onClose]);

  useEffect(() => clearSensitiveClipboard, [clearSensitiveClipboard, invite]);

  const copyValue = async (value: string, sensitive = false) => {
    await navigator.clipboard.writeText(value);
    if (!sensitive) return;
    sensitiveClipboardValue.current = value;
    window.setTimeout(() => {
      if (sensitiveClipboardValue.current === value) clearSensitiveClipboard();
    }, 30_000);
  };

  const close = () => {
    setPasswordVisible(false);
    clearSensitiveClipboard();
    onClose?.();
  };

  return (
    <Dialog open={invite !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="max-w-md overflow-hidden">
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
                  if (!event.currentTarget.open) setPasswordVisible(false);
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
                  <dl className="mt-3 space-y-3">
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Server</dt>
                      {invite.invite.signaling_urls.map((url) => (
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
                          {invite.invite.sync_room}
                        </code>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Raum kopieren"
                          onClick={() => void copyValue(invite.invite.sync_room)}
                        >
                          <CopyIcon aria-hidden />
                        </Button>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Passwort</dt>
                      <dd className="mt-1 flex items-center gap-2">
                        <code className="min-w-0 flex-1 break-all rounded-md bg-background px-2 py-1.5 text-xs">
                          {manualConnectionPasswordText(
                            invite.invite.signaling_room_password,
                            passwordVisible,
                          )}
                        </code>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={passwordVisible ? "Passwort verbergen" : "Passwort anzeigen"}
                          onClick={() => setPasswordVisible((visible) => !visible)}
                        >
                          {passwordVisible ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Passwort kopieren"
                          onClick={() =>
                            void copyValue(invite.invite.signaling_room_password, true)
                          }
                        >
                          <CopyIcon aria-hidden />
                        </Button>
                      </dd>
                    </div>
                  </dl>
                </div>
              </details>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
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
  onRetryDevices,
  revokingDeviceId = null,
  addingDevice = false,
  activeInvite = null,
  onCloseInvite,
  onRenewInvite,
  onRevokeInvite,
  revokingInvite = false,
}: {
  readonly instances: readonly CtoxManagedInstance[];
  readonly activeInstanceId: string | null;
  readonly loading?: boolean;
  readonly refreshDisabled?: boolean;
  readonly addDisabledReason?: string | null;
  readonly computerCount?: number;
  readonly devices?: readonly WorkjetDeviceBindingV1[];
  readonly devicesLoading?: boolean;
  readonly devicesError?: string | null;
  readonly deviceManagementBlockedReason?: string | null;
  readonly onSelectInstance?: (instanceId: string) => void;
  readonly onRefresh?: () => void;
  readonly onAddBusinessOs?: (invite: string) => Promise<string | null>;
  readonly onAddDevice?: () => void;
  readonly onRevokeDevice?: (devicePairingId: string) => void;
  readonly onRetryDevices?: () => void;
  readonly revokingDeviceId?: string | null;
  readonly addingDevice?: boolean;
  readonly activeInvite?: WorkjetDeviceInviteCreateResponseV1 | null;
  readonly onCloseInvite?: () => void;
  readonly onRenewInvite?: () => void;
  readonly onRevokeInvite?: () => void;
  readonly revokingInvite?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [invite, setInvite] = useState("");
  const [addingError, setAddingError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selected = instances.find((instance) => instance.id === activeInstanceId) ?? null;
  const selectedDisplayName = selected === null ? null : ctoxInstanceDisplayTitle(selected);

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
          Verwalte die aktive Instanz, deine Workjet-Geräte und die zugehörigen Code-Rechner.
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
        <div className="max-w-3xl rounded-xl border border-border/80 bg-card/30 p-4 sm:p-5">
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
                    {ctoxInstanceDisplayTitle(instance)}
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
                    ? "Instanz auswählen"
                    : `Geräte für ${selectedDisplayName}`}
                </p>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  {selected === null
                    ? "Wähle zuerst eine Business-OS-Instanz."
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
                  key={device.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {device.displayName || `Workjet-Gerät · ${device.deviceId.slice(-8)}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {device.pairedAtMs === null
                        ? "Einladung erstellt"
                        : `Verbunden am ${new Date(device.pairedAtMs).toLocaleDateString()}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revokingDeviceId === device.id}
                      onClick={() => onRevokeDevice?.(device.id)}
                    >
                      {revokingDeviceId === device.id ? <Spinner className="size-3.5" /> : null}
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
        <div className="max-w-3xl rounded-xl border border-border/80 bg-card/20 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <LaptopIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">
                {selectedDisplayName === null
                  ? "Instanz auswählen"
                  : `Zuweisungen zu ${selectedDisplayName}`}
              </p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                {computerCount === 0
                  ? "Im globalen Computer-Inventar sind noch keine Rechner eingerichtet."
                  : `${computerCount} Rechner sind eingerichtet. Weise sie dieser Business-OS-Instanz im Computer-Inventar zu.`}
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

      <DevicePairingDialog
        instanceName={selectedDisplayName}
        invite={activeInvite}
        onClose={onCloseInvite}
        onRenew={onRenewInvite}
        onRevoke={onRevokeInvite}
        revoking={revokingInvite}
      />
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

class BusinessOsDeviceControlError extends Error {
  constructor(readonly code: "not_active" | "unsupported" | "guest_failed" | "invalid_input") {
    super(code);
  }
}

async function requestBusinessOsDeviceControl(
  bridge: DesktopCtoxBridge | undefined,
  instanceId: string,
  request: WorkjetDeviceWebRtcRequestV1,
): Promise<WorkjetDeviceWebRtcResponseV1> {
  if (bridge?.requestDeviceControl === undefined) {
    throw new BusinessOsDeviceControlError("unsupported");
  }
  const result = await bridge.requestDeviceControl(instanceId, request);
  if (result._tag === "failed") throw new BusinessOsDeviceControlError(result.code);
  return result.response;
}

function deviceControlErrorMessage(error: unknown, instanceName: string): string {
  if (error instanceof BusinessOsDeviceControlError) {
    if (error.code === "not_active") {
      return `Öffne ${instanceName} einmal in Business OS, damit die direkte Geräteverbindung aufgebaut wird.`;
    }
    if (error.code === "unsupported") {
      return `Die Shell von ${instanceName} unterstützt die Geräteverbindung noch nicht. Aktualisiere die Business-OS-Shell.`;
    }
  }
  return `Die direkte Geräteverbindung zu ${instanceName} ist unterbrochen. Öffne Business OS und versuche es erneut.`;
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
  const [devices, setDevices] = useState<readonly WorkjetDeviceBindingV1[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [deviceRefreshKey, setDeviceRefreshKey] = useState(0);
  const [addingDevice, setAddingDevice] = useState(false);
  const [activeInvite, setActiveInvite] = useState<WorkjetDeviceInviteCreateResponseV1 | null>(
    null,
  );
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [revokingInvite, setRevokingInvite] = useState(false);
  const deviceControlAvailable = bridge?.requestDeviceControl !== undefined;

  useEffect(() => {
    if (discovery === "loading" || discovery._tag !== "ready") return;
    if (
      activeInstanceId !== null &&
      !instances.some((instance) => instance.id === activeInstanceId)
    ) {
      crossModeSelectionMemory.forget("business-os");
    }
  }, [activeInstanceId, discovery, instances]);

  const selectInstance = (instanceId: string) => {
    if (!instances.some((instance) => instance.id === instanceId)) return;
    const previousInstanceId = activeInstanceId;
    const previousInviteId = activeInvite?.inviteId;
    setActiveInvite(null);
    if (previousInstanceId !== null && previousInviteId !== undefined) {
      void requestBusinessOsDeviceControl(bridge, previousInstanceId, {
        action: "invite.revoke",
        inviteId: previousInviteId,
      }).catch(() => undefined);
    }
    crossModeSelectionMemory.remember({ mode: "business-os", ctoxInstanceId: instanceId });
  };

  useEffect(() => {
    setActiveInvite(null);
    setDevices([]);
    setDevicesLoading(false);
    setDevicesError(null);
  }, [activeInstanceId, bridge]);

  useEffect(() => {
    setDevices([]);
    setDevicesError(null);
    if (!deviceControlAvailable || activeInstanceId === null) return;
    let cancelled = false;
    setDevicesLoading(true);
    void (async () => {
      try {
        const response = await requestBusinessOsDeviceControl(bridge, activeInstanceId, {
          action: "binding.list",
        });
        if (!("bindings" in response)) throw new BusinessOsDeviceControlError("guest_failed");
        if (cancelled) return;
        setDevices(response.bindings);
        setDevicesError(null);
        setDevicesLoading(false);
      } catch (error) {
        if (cancelled) return;
        setDevices([]);
        const instance = instances.find((candidate) => candidate.id === activeInstanceId);
        setDevicesError(
          deviceControlErrorMessage(
            error,
            instance === undefined ? "Business OS" : ctoxInstanceDisplayTitle(instance),
          ),
        );
        setDevicesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeInstanceId, bridge, deviceControlAvailable, deviceRefreshKey, instances]);

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
      : !deviceControlAvailable
        ? `Diese Workjet-Ausgabe unterstützt die direkte Geräteverbindung für ${ctoxInstanceDisplayTitle(selected)} noch nicht.`
        : null;

  const createDeviceInvite = async () => {
    if (activeInstanceId === null) return;
    setAddingDevice(true);
    setDevicesError(null);
    try {
      const response = await requestBusinessOsDeviceControl(bridge, activeInstanceId, {
        action: "invite.create",
        ttlSeconds: 300,
        displayName: "Workjet-Gerät",
      });
      if (!("invite" in response)) throw new BusinessOsDeviceControlError("guest_failed");
      setActiveInvite(response);
    } catch (error) {
      setDevicesError(
        deviceControlErrorMessage(
          error,
          selected ? ctoxInstanceDisplayTitle(selected) : "Business OS",
        ),
      );
    } finally {
      setAddingDevice(false);
    }
  };

  const revokeInvite = async () => {
    const invite = activeInvite;
    if (activeInstanceId === null || invite === null) return;
    setActiveInvite(null);
    setRevokingInvite(true);
    try {
      const response = await requestBusinessOsDeviceControl(bridge, activeInstanceId, {
        action: "invite.revoke",
        inviteId: invite.inviteId,
      });
      if (!("revoked" in response)) throw new BusinessOsDeviceControlError("guest_failed");
    } catch {
      setDevicesError("Die Einladung konnte nicht widerrufen werden. Bitte erneut versuchen.");
    } finally {
      setRevokingInvite(false);
    }
  };

  const renewInvite = async () => {
    const invite = activeInvite;
    if (activeInstanceId === null || invite === null) return;
    setActiveInvite(null);
    setRevokingInvite(true);
    try {
      const revoked = await requestBusinessOsDeviceControl(bridge, activeInstanceId, {
        action: "invite.revoke",
        inviteId: invite.inviteId,
      });
      if (!("revoked" in revoked)) throw new BusinessOsDeviceControlError("guest_failed");
      const created = await requestBusinessOsDeviceControl(bridge, activeInstanceId, {
        action: "invite.create",
        ttlSeconds: 300,
        displayName: "Workjet-Gerät",
      });
      if (!("invite" in created)) throw new BusinessOsDeviceControlError("guest_failed");
      setActiveInvite(created);
    } catch {
      setDevicesError("Es konnte kein neuer QR-Code erstellt werden. Bitte erneut versuchen.");
    } finally {
      setRevokingInvite(false);
    }
  };

  const revokeDevice = async (bindingId: string) => {
    if (activeInstanceId === null) return;
    setRevokingDeviceId(bindingId);
    try {
      const response = await requestBusinessOsDeviceControl(bridge, activeInstanceId, {
        action: "binding.revoke",
        bindingId,
      });
      if (!("revoked" in response)) throw new BusinessOsDeviceControlError("guest_failed");
      setDeviceRefreshKey((key) => key + 1);
    } catch {
      setDevicesError("Das Gerät konnte nicht getrennt werden. Bitte erneut versuchen.");
    } finally {
      setRevokingDeviceId(null);
    }
  };

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
      {...(!deviceControlAvailable ? {} : { onAddDevice: () => void createDeviceInvite() })}
      addingDevice={addingDevice}
      onRetryDevices={() => setDeviceRefreshKey((key) => key + 1)}
      onRevokeDevice={(devicePairingId) => void revokeDevice(devicePairingId)}
      revokingDeviceId={revokingDeviceId}
      activeInvite={activeInvite}
      onCloseInvite={() => void revokeInvite()}
      onRevokeInvite={() => void revokeInvite()}
      onRenewInvite={() => void renewInvite()}
      revokingInvite={revokingInvite}
    />
  );
}
