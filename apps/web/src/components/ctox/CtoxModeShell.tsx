import type {
  CtoxDiscoveryResult,
  CtoxGuestBounds,
  CtoxInstanceApp,
  CtoxManagedGuestResult,
  CtoxManagedInstance,
  CtoxManagedInstanceSource,
  CtoxManualPairingImportInput,
  DesktopCtoxBridge,
} from "@t3tools/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarContent, SidebarGroup, SidebarInset } from "../ui/sidebar";

type CtoxManagedState = "loading" | "ready" | "signed_out" | "failed";
type CtoxConnectionState = "idle" | "connecting" | "ready" | "error" | "revoked";
type CtoxSourceGroupKey = "managed" | "paired" | "local" | "ssh";

interface CtoxSourceGroup {
  readonly key: CtoxSourceGroupKey;
  readonly label: string;
  readonly instances: readonly CtoxManagedInstance[];
}

export interface CtoxMutationOutcome {
  readonly ok: boolean;
  readonly message: string;
}

export interface CtoxManualPairingFormValues {
  readonly displayName: string;
  readonly instanceId: string;
  readonly syncRoom: string;
  readonly signalingUrls: string;
  readonly roomSecret: string;
  readonly capabilityToken: string;
  readonly capabilityExpiresAtMs: string;
  readonly role: string;
  readonly userId: string;
}

export const CTOX_IMPORT_SUCCESS_MESSAGE = "Instance added.";
export const CTOX_IMPORT_ERROR_MESSAGE =
  "Instance could not be added. Check the entry and try again.";
export const CTOX_REMOVE_SUCCESS_MESSAGE = "Paired instance removed.";
export const CTOX_REMOVE_ERROR_MESSAGE = "Paired instance could not be removed. Try again.";

const SOURCE_GROUP_DEFINITIONS: readonly {
  readonly key: CtoxSourceGroupKey;
  readonly label: string;
}[] = [
  { key: "managed", label: "Managed" },
  { key: "paired", label: "Paired" },
  { key: "local", label: "Local" },
  { key: "ssh", label: "SSH" },
];

const SOURCE_LABELS: Record<CtoxManagedInstanceSource, string> = {
  ctox_dev: "ctox.dev",
  pairing_invite: "Desktop invite",
  manual_pairing: "Manual pairing",
  local_daemon: "Local daemon",
  ssh_managed: "SSH managed",
};

const STATUS_LABELS: Record<CtoxManagedInstance["status"], string> = {
  available: "Available",
  offline: "Offline",
  needs_auth: "Needs authentication",
  pairing_expired: "Pairing expired",
  paired: "Paired",
  installing: "Installing",
  error: "Error",
};

interface CtoxModeContextValue {
  readonly discovery: "loading" | CtoxDiscoveryResult;
  readonly refreshing: boolean;
  readonly selectedId: string | null;
  readonly activationKey: number;
  readonly connection: CtoxConnectionState;
  readonly modeReady: boolean;
  readonly bridge: DesktopCtoxBridge | undefined;
  readonly refresh: () => void;
  readonly login: () => void;
  readonly logout: () => void;
  readonly importInvite: (invite: string) => Promise<CtoxMutationOutcome>;
  readonly importManualPairing: (
    input: CtoxManualPairingImportInput,
  ) => Promise<CtoxMutationOutcome>;
  readonly removePairedInstance: (instance: CtoxManagedInstance) => Promise<CtoxMutationOutcome>;
  readonly select: (instance: CtoxManagedInstance) => void;
  readonly setConnection: (state: CtoxConnectionState) => void;
  /** Open a Business OS app: activates the instance guest if needed. */
  readonly openApp: (instance: CtoxManagedInstance, moduleId: string) => void;
  /** Pin or unpin an app on the instance rail (taskbar model). */
  readonly setAppDocked: (instance: CtoxManagedInstance, moduleId: string, docked: boolean) => void;
  /** Bumped whenever rail-relevant state changed; app rails reload on it. */
  readonly appRailVersion: number;
  /** The guest host reports its latest bounds for app-open activations. */
  readonly reportGuestBounds: (bounds: CtoxGuestBounds) => void;
}

const CtoxModeContext = createContext<CtoxModeContextValue | null>(null);

export function isPairedCtoxInstance(instance: CtoxManagedInstance): boolean {
  return instance.source === "pairing_invite" || instance.source === "manual_pairing";
}

export function canActivateCtoxInstance(instance: CtoxManagedInstance): boolean {
  if (instance.source === "ctox_dev") return instance.status === "available";
  return isPairedCtoxInstance(instance) && instance.status === "paired";
}

export function getCtoxManagedState(discovery: "loading" | CtoxDiscoveryResult): CtoxManagedState {
  if (discovery === "loading") return "loading";
  if (discovery._tag !== "ready") return discovery._tag;
  return discovery.managedState ?? "ready";
}

function sourceGroupKey(source: CtoxManagedInstanceSource): CtoxSourceGroupKey {
  if (source === "ctox_dev") return "managed";
  if (source === "local_daemon") return "local";
  if (source === "ssh_managed") return "ssh";
  return "paired";
}

export function groupCtoxInstances(
  instances: readonly CtoxManagedInstance[],
): readonly CtoxSourceGroup[] {
  return SOURCE_GROUP_DEFINITIONS.map(({ key, label }) => ({
    key,
    label,
    instances: instances
      .filter((instance) => sourceGroupKey(instance.source) === key)
      .toSorted((left, right) =>
        left.displayName === right.displayName
          ? left.id.localeCompare(right.id)
          : left.displayName.localeCompare(right.displayName),
      ),
  }));
}

export function activateCtoxInstance(
  bridge: DesktopCtoxBridge | undefined,
  instance: CtoxManagedInstance,
  bounds: CtoxGuestBounds,
): Promise<CtoxManagedGuestResult> | undefined {
  if (bridge === undefined || !canActivateCtoxInstance(instance)) return undefined;
  return bridge.activate(instance.id, bounds);
}

export async function submitCtoxInvite(
  bridge: DesktopCtoxBridge | undefined,
  invite: string,
): Promise<CtoxMutationOutcome> {
  if (bridge === undefined) return { ok: false, message: CTOX_IMPORT_ERROR_MESSAGE };
  try {
    const result = await bridge.importInvite(invite);
    return result._tag === "completed"
      ? { ok: true, message: CTOX_IMPORT_SUCCESS_MESSAGE }
      : { ok: false, message: CTOX_IMPORT_ERROR_MESSAGE };
  } catch {
    return { ok: false, message: CTOX_IMPORT_ERROR_MESSAGE };
  }
}

export async function submitCtoxManualPairing(
  bridge: DesktopCtoxBridge | undefined,
  input: CtoxManualPairingImportInput,
): Promise<CtoxMutationOutcome> {
  if (bridge === undefined) return { ok: false, message: CTOX_IMPORT_ERROR_MESSAGE };
  try {
    const result = await bridge.importManualPairing(input);
    return result._tag === "completed"
      ? { ok: true, message: CTOX_IMPORT_SUCCESS_MESSAGE }
      : { ok: false, message: CTOX_IMPORT_ERROR_MESSAGE };
  } catch {
    return { ok: false, message: CTOX_IMPORT_ERROR_MESSAGE };
  }
}

export function buildCtoxManualPairingInput(
  values: CtoxManualPairingFormValues,
): CtoxManualPairingImportInput {
  return {
    displayName: values.displayName,
    syncRoom: values.syncRoom,
    signalingUrls: values.signalingUrls
      .split(/[\n,]+/u)
      .map((value) => value.trim())
      .filter((value) => value !== ""),
    roomSecret: values.roomSecret,
    ...(values.instanceId === "" ? {} : { instanceId: values.instanceId }),
    ...(values.capabilityToken === "" ? {} : { capabilityToken: values.capabilityToken }),
    ...(values.capabilityExpiresAtMs === ""
      ? {}
      : { capabilityExpiresAtMs: Number(values.capabilityExpiresAtMs) }),
    ...(values.role === "" ? {} : { role: values.role }),
    ...(values.userId === "" ? {} : { userId: values.userId }),
  };
}

export async function removeCtoxPairedInstance(
  bridge: DesktopCtoxBridge | undefined,
  instance: CtoxManagedInstance,
): Promise<CtoxMutationOutcome> {
  if (bridge === undefined || !isPairedCtoxInstance(instance)) {
    return { ok: false, message: CTOX_REMOVE_ERROR_MESSAGE };
  }
  try {
    const result = await bridge.removePairedInstance(instance.id);
    return result._tag === "completed"
      ? { ok: true, message: CTOX_REMOVE_SUCCESS_MESSAGE }
      : { ok: false, message: CTOX_REMOVE_ERROR_MESSAGE };
  } catch {
    return { ok: false, message: CTOX_REMOVE_ERROR_MESSAGE };
  }
}

export function releaseCtoxGuest(bridge: DesktopCtoxBridge | undefined): void {
  void bridge?.deactivate().catch(() => undefined);
}

export function releaseCtoxMode(bridge: DesktopCtoxBridge | undefined): void {
  void bridge?.exitBusinessOsMode().catch(() => undefined);
}

function useCtoxMode(): CtoxModeContextValue {
  const value = useContext(CtoxModeContext);
  if (value === null) throw new Error("CTOX mode shell must be rendered inside CtoxModeProvider.");
  return value;
}

export function CtoxModeProvider({
  children,
  initialDiscovery = "loading",
  bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.ctox,
}: {
  readonly children: ReactNode;
  readonly initialDiscovery?: "loading" | CtoxDiscoveryResult;
  readonly bridge?: DesktopCtoxBridge;
}) {
  const [discovery, setDiscovery] = useState<"loading" | CtoxDiscoveryResult>(initialDiscovery);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activationKey, setActivationKey] = useState(0);
  const [connection, setConnection] = useState<CtoxConnectionState>("idle");
  const [modeReady, setModeReady] = useState(bridge === undefined);
  const mountedRef = useRef(true);
  const selectedIdRef = useRef<string | null>(null);

  const clearSelection = useCallback(
    (nextConnection: CtoxConnectionState) => {
      selectedIdRef.current = null;
      setSelectedId(null);
      setConnection(nextConnection);
      releaseCtoxGuest(bridge);
    },
    [bridge],
  );

  const applyDiscovery = useCallback(
    (next: CtoxDiscoveryResult) => {
      if (!mountedRef.current) return;
      setDiscovery(next);
      const current = selectedIdRef.current;
      if (current === null) return;
      const currentInstance =
        next._tag === "ready"
          ? next.instances.find((instance) => instance.id === current)
          : undefined;
      if (currentInstance !== undefined && canActivateCtoxInstance(currentInstance)) return;
      clearSelection("revoked");
    },
    [clearSelection],
  );

  const refresh = useCallback(() => {
    if (bridge === undefined) {
      setDiscovery({ _tag: "failed", code: "network_error" });
      return;
    }
    setRefreshing(true);
    void bridge
      .refresh()
      .then(applyDiscovery, () => applyDiscovery({ _tag: "failed", code: "network_error" }))
      .finally(() => {
        if (mountedRef.current) setRefreshing(false);
      });
  }, [applyDiscovery, bridge]);

  const login = useCallback(() => {
    if (bridge === undefined) return;
    setRefreshing(true);
    void bridge
      .login()
      .then((result) => {
        if (result._tag === "completed") applyDiscovery(result.discovery);
      })
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) setRefreshing(false);
      });
  }, [applyDiscovery, bridge]);

  const logout = useCallback(() => {
    if (bridge === undefined) return;
    setRefreshing(true);
    void bridge
      .logout()
      .then((result) => {
        if (!mountedRef.current || result._tag !== "completed") return;
        clearSelection("idle");
        setDiscovery((current) => {
          if (current === "loading" || current._tag !== "ready") return { _tag: "signed_out" };
          return {
            _tag: "ready",
            instances: current.instances.filter((instance) => instance.source !== "ctox_dev"),
            managedState: "signed_out",
          };
        });
        refresh();
      })
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) setRefreshing(false);
      });
  }, [bridge, clearSelection, refresh]);

  const importInvite = useCallback(
    async (invite: string) => {
      const outcome = await submitCtoxInvite(bridge, invite);
      if (outcome.ok) refresh();
      return outcome;
    },
    [bridge, refresh],
  );

  const importManualPairing = useCallback(
    async (input: CtoxManualPairingImportInput) => {
      const outcome = await submitCtoxManualPairing(bridge, input);
      if (outcome.ok) refresh();
      return outcome;
    },
    [bridge, refresh],
  );

  const removePairedInstance = useCallback(
    async (instance: CtoxManagedInstance) => {
      const outcome = await removeCtoxPairedInstance(bridge, instance);
      if (!outcome.ok) return outcome;
      if (selectedIdRef.current === instance.id) clearSelection("idle");
      refresh();
      return outcome;
    },
    [bridge, clearSelection, refresh],
  );

  const select = useCallback((instance: CtoxManagedInstance) => {
    if (!canActivateCtoxInstance(instance)) return;
    selectedIdRef.current = instance.id;
    setSelectedId(instance.id);
    setActivationKey((current) => current + 1);
    setConnection("connecting");
  }, []);

  const [appRailVersion, setAppRailVersion] = useState(0);
  const guestBoundsRef = useRef<CtoxGuestBounds | null>(null);
  const pendingOpenRef = useRef<{ instanceId: string; moduleId: string } | null>(null);

  const reportGuestBounds = useCallback((bounds: CtoxGuestBounds) => {
    guestBoundsRef.current = bounds;
  }, []);

  const dispatchOpenApp = useCallback(
    (instanceId: string, moduleId: string) => {
      if (bridge === undefined) return;
      const bounds = guestBoundsRef.current ?? { x: 0, y: 0, width: 1, height: 1 };
      void bridge
        .openApp(instanceId, moduleId, bounds)
        .catch(() => undefined)
        .then(() => {
          if (mountedRef.current) setAppRailVersion((current) => current + 1);
        });
    },
    [bridge],
  );

  const openApp = useCallback(
    (instance: CtoxManagedInstance, moduleId: string) => {
      if (!canActivateCtoxInstance(instance)) return;
      if (selectedIdRef.current === instance.id) {
        pendingOpenRef.current = null;
        dispatchOpenApp(instance.id, moduleId);
        return;
      }
      // Selecting first keeps the renderer's activation flow authoritative;
      // the open dispatches once the guest reports ready.
      pendingOpenRef.current = { instanceId: instance.id, moduleId };
      select(instance);
    },
    [dispatchOpenApp, select],
  );

  useEffect(() => {
    if (connection !== "ready") {
      if (connection === "idle" || connection === "error" || connection === "revoked") {
        pendingOpenRef.current = null;
      }
      return;
    }
    setAppRailVersion((current) => current + 1);
    const pending = pendingOpenRef.current;
    if (pending === null || pending.instanceId !== selectedIdRef.current) return;
    pendingOpenRef.current = null;
    dispatchOpenApp(pending.instanceId, pending.moduleId);
  }, [connection, dispatchOpenApp]);

  const setAppDocked = useCallback(
    (instance: CtoxManagedInstance, moduleId: string, docked: boolean) => {
      if (bridge === undefined) return;
      void bridge
        .setAppDocked(instance.id, moduleId, docked)
        .catch(() => undefined)
        .then(() => {
          if (mountedRef.current) setAppRailVersion((current) => current + 1);
        });
    },
    [bridge],
  );

  useLayoutEffect(() => {
    mountedRef.current = true;
    setModeReady(bridge === undefined);
    if (bridge !== undefined) {
      void bridge
        .enterBusinessOsMode()
        .then((result) => {
          if (mountedRef.current && result._tag === "completed") setModeReady(true);
        })
        .catch(() => undefined);
    }
    refresh();
    return () => {
      mountedRef.current = false;
      setModeReady(false);
      // Request native detachment during the mode-switch commit, before the
      // Code shell can be painted underneath a stale WebContentsView.
      releaseCtoxMode(bridge);
    };
  }, [bridge, refresh]);

  const value = useMemo<CtoxModeContextValue>(
    () => ({
      discovery,
      refreshing,
      selectedId,
      activationKey,
      connection,
      modeReady,
      bridge,
      refresh,
      login,
      logout,
      importInvite,
      importManualPairing,
      removePairedInstance,
      select,
      setConnection,
      openApp,
      setAppDocked,
      appRailVersion,
      reportGuestBounds,
    }),
    [
      activationKey,
      appRailVersion,
      bridge,
      connection,
      discovery,
      importInvite,
      importManualPairing,
      login,
      logout,
      modeReady,
      openApp,
      refresh,
      refreshing,
      removePairedInstance,
      reportGuestBounds,
      select,
      selectedId,
      setAppDocked,
    ],
  );

  return <CtoxModeContext value={value}>{children}</CtoxModeContext>;
}

function statusLabel(instance: CtoxManagedInstance): string {
  const health = instance.healthSummary.dataPlaneReady ? "WebRTC ready" : "WebRTC unavailable";
  return `${STATUS_LABELS[instance.status]} · ${health}`;
}

/**
 * The T3 analogy row set: instance = project, app = session. Docked apps are
 * always listed (greyed via the disabled instance state while disconnected);
 * undocked apps appear only while open; the open app carries a dock-style dot.
 */
function CtoxInstanceAppRail({
  instance,
  launchable,
}: {
  readonly instance: CtoxManagedInstance;
  readonly launchable: boolean;
}) {
  const { bridge, selectedId, connection, openApp, setAppDocked, appRailVersion } = useCtoxMode();
  const [apps, setApps] = useState<readonly CtoxInstanceApp[]>([]);
  const [source, setSource] = useState<"live" | "cache">("cache");
  const instanceReady = selectedId === instance.id && connection === "ready";

  useEffect(() => {
    if (bridge === undefined) return;
    let cancelled = false;
    void bridge.listApps(instance.id).then(
      (result) => {
        if (cancelled || result._tag !== "completed") return;
        setApps(result.apps);
        setSource(result.source);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [appRailVersion, bridge, instance.id, instanceReady]);

  return (
    <CtoxAppRailList
      instance={instance}
      apps={apps}
      instanceReady={instanceReady}
      source={source}
      launchable={launchable}
      onOpen={(moduleId) => openApp(instance, moduleId)}
      onToggleDock={(moduleId, docked) => setAppDocked(instance, moduleId, docked)}
    />
  );
}

/** Pure app-rail rows; exported for deterministic state rendering in tests. */
export function CtoxAppRailList({
  instance,
  apps,
  instanceReady,
  source,
  launchable,
  onOpen,
  onToggleDock,
}: {
  readonly instance: CtoxManagedInstance;
  readonly apps: readonly CtoxInstanceApp[];
  readonly instanceReady: boolean;
  readonly source: "live" | "cache";
  readonly launchable: boolean;
  readonly onOpen: (moduleId: string) => void;
  readonly onToggleDock: (moduleId: string, docked: boolean) => void;
}) {
  if (apps.length === 0) return null;
  const stale = !instanceReady || source === "cache";
  return (
    <ul
      className="space-y-0.5 border-t border-sidebar-border/40 px-1.5 py-1"
      aria-label={`Apps of ${instance.displayName}`}
    >
      {apps.map((app) => {
        const open = app.open && instanceReady;
        return (
          <li key={app.id} className="group/ctox-app flex items-center gap-1">
            <button
              type="button"
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
                open
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/40",
                stale && !open && "text-sidebar-muted-foreground",
                !launchable && "cursor-not-allowed opacity-60",
              )}
              disabled={!launchable}
              aria-current={open ? "true" : undefined}
              data-ctox-app-id={app.id}
              data-ctox-app-open={open}
              data-ctox-app-docked={app.docked}
              title={launchable ? undefined : "This instance is not available."}
              onClick={() => onOpen(app.id)}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  open ? "bg-sidebar-primary" : "bg-sidebar-muted-foreground/40",
                )}
              />
              <span className="truncate">{app.title ?? app.id}</span>
            </button>
            <button
              type="button"
              className="invisible shrink-0 rounded p-1 text-[10px] text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:visible group-hover/ctox-app:visible"
              title={app.docked ? "Undock app" : "Dock app"}
              aria-label={`${app.docked ? "Undock" : "Dock"} ${app.title ?? app.id}`}
              onClick={() => onToggleDock(app.id, !app.docked)}
            >
              {app.docked ? "Unpin" : "Pin"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function CtoxInstanceList({
  instances,
  label,
  removingId,
  onRemove,
}: {
  readonly instances: readonly CtoxManagedInstance[];
  readonly label: string;
  readonly removingId?: string | null;
  readonly onRemove?: (instance: CtoxManagedInstance) => void;
}) {
  const { selectedId, connection, select } = useCtoxMode();
  return (
    <div className="space-y-2" aria-label={label}>
      {instances.map((instance) => {
        const selected = selectedId === instance.id;
        const busy = selected && connection === "connecting";
        const launchable = canActivateCtoxInstance(instance);
        const paired = isPairedCtoxInstance(instance);
        return (
          <div
            key={instance.id}
            className={cn(
              "rounded-lg border transition-colors",
              selected
                ? "border-sidebar-primary/50 bg-sidebar-accent text-sidebar-accent-foreground"
                : "border-sidebar-border/70 bg-sidebar-accent/20 text-sidebar-foreground",
              !launchable && "opacity-70",
            )}
          >
            <button
              type="button"
              className={cn(
                "w-full px-3 py-2.5 text-left",
                launchable ? "hover:bg-sidebar-accent/50" : "cursor-not-allowed",
              )}
              aria-pressed={selected}
              aria-busy={busy}
              data-ctox-instance-source={instance.source}
              data-ctox-instance-status={instance.status}
              disabled={!launchable || busy}
              title={paired && !launchable ? "This pairing is not available." : undefined}
              onClick={() => select(instance)}
            >
              <span className="block text-sm font-medium">{instance.displayName}</span>
              <span className="mt-0.5 block text-xs text-sidebar-muted-foreground">
                Source: {SOURCE_LABELS[instance.source]}
              </span>
              {instance.role !== undefined || instance.domain !== undefined ? (
                <span className="mt-0.5 block text-xs text-sidebar-muted-foreground">
                  {[
                    instance.role === undefined ? undefined : `Role: ${instance.role}`,
                    instance.domain === undefined ? undefined : `Domain: ${instance.domain}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
              <span className="mt-1 block text-xs text-sidebar-muted-foreground">
                Status: {statusLabel(instance)}
              </span>
            </button>
            <CtoxInstanceAppRail instance={instance} launchable={launchable} />
            {paired && onRemove !== undefined ? (
              <div className="border-t border-sidebar-border/60 px-3 py-1.5 text-right">
                <button
                  type="button"
                  className="text-xs text-sidebar-muted-foreground underline-offset-2 hover:text-sidebar-foreground hover:underline disabled:opacity-50"
                  disabled={removingId === instance.id}
                  aria-busy={removingId === instance.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(instance);
                  }}
                >
                  Remove
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function CtoxManagedInstanceList({
  instances,
}: {
  readonly instances: readonly CtoxManagedInstance[];
}) {
  return <CtoxInstanceList instances={instances} label="Managed CTOX instances" />;
}

const fieldClassName =
  "mt-1 w-full rounded-md border border-sidebar-border bg-sidebar-accent/20 px-2 py-1.5 text-xs text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground focus:border-sidebar-primary/60";

function PairingAddSurface({
  onClose,
  onImported,
}: {
  readonly onClose: () => void;
  readonly onImported: (outcome: CtoxMutationOutcome) => void;
}) {
  const { importInvite, importManualPairing } = useCtoxMode();
  const [choice, setChoice] = useState<"invite" | "manual">("invite");
  const [invite, setInvite] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [syncRoom, setSyncRoom] = useState("");
  const [signalingUrls, setSignalingUrls] = useState("");
  const [roomSecret, setRoomSecret] = useState("");
  const [capabilityToken, setCapabilityToken] = useState("");
  const [capabilityExpiresAtMs, setCapabilityExpiresAtMs] = useState("");
  const [role, setRole] = useState("");
  const [userId, setUserId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<CtoxMutationOutcome | null>(null);

  const clearPairingState = useCallback(() => {
    setInvite("");
    setDisplayName("");
    setInstanceId("");
    setSyncRoom("");
    setSignalingUrls("");
    setRoomSecret("");
    setCapabilityToken("");
    setCapabilityExpiresAtMs("");
    setRole("");
    setUserId("");
    setFeedback(null);
  }, []);

  const close = () => {
    clearPairingState();
    onClose();
  };

  const finish = (outcome: CtoxMutationOutcome) => {
    setFeedback(outcome);
    if (!outcome.ok) return;
    clearPairingState();
    onImported(outcome);
    onClose();
  };

  const submitInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    void importInvite(invite)
      .then(finish)
      .finally(() => setSubmitting(false));
  };

  const submitManual = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    const input = buildCtoxManualPairingInput({
      displayName,
      instanceId,
      syncRoom,
      signalingUrls,
      roomSecret,
      capabilityToken,
      capabilityExpiresAtMs,
      role,
      userId,
    });
    void importManualPairing(input)
      .then(finish)
      .finally(() => setSubmitting(false));
  };

  const choose = (next: "invite" | "manual") => {
    clearPairingState();
    setChoice(next);
  };

  return (
    <div className="mt-3 rounded-lg border border-sidebar-border/70 bg-sidebar-accent/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-sidebar-foreground">Add instance</p>
        <button
          type="button"
          className="text-xs text-sidebar-muted-foreground hover:text-sidebar-foreground"
          onClick={close}
        >
          Cancel
        </button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-sidebar-accent/30 p-1">
        <button
          type="button"
          className={cn(
            "rounded px-2 py-1 text-xs",
            choice === "invite"
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-muted-foreground",
          )}
          aria-pressed={choice === "invite"}
          onClick={() => choose("invite")}
        >
          Invite
        </button>
        <button
          type="button"
          className={cn(
            "rounded px-2 py-1 text-xs",
            choice === "manual"
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-muted-foreground",
          )}
          aria-pressed={choice === "manual"}
          onClick={() => choose("manual")}
        >
          Manual pairing
        </button>
      </div>

      {choice === "invite" ? (
        <form className="mt-3" onSubmit={submitInvite}>
          <label className="block text-xs text-sidebar-muted-foreground">
            Invite JSON or CTOX desktop invite link
            <textarea
              className={cn(fieldClassName, "min-h-20 resize-y")}
              value={invite}
              onChange={(event) => setInvite(event.target.value)}
              autoComplete="off"
              required
              maxLength={65_536}
            />
          </label>
          <button
            type="submit"
            className="mt-3 rounded-md bg-sidebar-primary px-3 py-1.5 text-xs font-medium text-sidebar-primary-foreground disabled:opacity-50"
            disabled={submitting}
            aria-busy={submitting}
          >
            Add from invite
          </button>
        </form>
      ) : (
        <form className="mt-3 space-y-2" onSubmit={submitManual}>
          <label className="block text-xs text-sidebar-muted-foreground">
            Display name
            <input
              className={fieldClassName}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="off"
              required
              maxLength={256}
            />
          </label>
          <label className="block text-xs text-sidebar-muted-foreground">
            Instance ID (optional)
            <input
              className={fieldClassName}
              value={instanceId}
              onChange={(event) => setInstanceId(event.target.value)}
              autoComplete="off"
              maxLength={256}
            />
          </label>
          <label className="block text-xs text-sidebar-muted-foreground">
            Sync room
            <input
              className={fieldClassName}
              value={syncRoom}
              onChange={(event) => setSyncRoom(event.target.value)}
              autoComplete="off"
              required
              maxLength={273}
            />
          </label>
          <label className="block text-xs text-sidebar-muted-foreground">
            Signaling URLs (one per line or comma-separated)
            <textarea
              className={cn(fieldClassName, "min-h-16 resize-y")}
              value={signalingUrls}
              onChange={(event) => setSignalingUrls(event.target.value)}
              autoComplete="off"
              required
              maxLength={32_768}
            />
          </label>
          <label className="block text-xs text-sidebar-muted-foreground">
            Room secret
            <input
              type="password"
              className={fieldClassName}
              value={roomSecret}
              onChange={(event) => setRoomSecret(event.target.value)}
              autoComplete="off"
              required
              maxLength={4_096}
            />
          </label>
          <label className="block text-xs text-sidebar-muted-foreground">
            Capability token (optional)
            <input
              type="password"
              className={fieldClassName}
              value={capabilityToken}
              onChange={(event) => setCapabilityToken(event.target.value)}
              autoComplete="off"
              maxLength={16_384}
            />
          </label>
          <label className="block text-xs text-sidebar-muted-foreground">
            Expiry in Unix milliseconds (optional)
            <input
              type="number"
              min={1}
              step={1}
              className={fieldClassName}
              value={capabilityExpiresAtMs}
              onChange={(event) => setCapabilityExpiresAtMs(event.target.value)}
            />
          </label>
          <label className="block text-xs text-sidebar-muted-foreground">
            Role (optional)
            <input
              className={fieldClassName}
              value={role}
              onChange={(event) => setRole(event.target.value)}
              autoComplete="off"
              maxLength={128}
            />
          </label>
          <label className="block text-xs text-sidebar-muted-foreground">
            User ID (optional)
            <input
              className={fieldClassName}
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              autoComplete="off"
              maxLength={256}
            />
          </label>
          <button
            type="submit"
            className="rounded-md bg-sidebar-primary px-3 py-1.5 text-xs font-medium text-sidebar-primary-foreground disabled:opacity-50"
            disabled={submitting}
            aria-busy={submitting}
          >
            Add manual pairing
          </button>
        </form>
      )}

      {feedback === null ? null : (
        <p
          className={cn(
            "mt-2 text-xs",
            feedback.ok ? "text-sidebar-foreground" : "text-destructive",
          )}
          role={feedback.ok ? "status" : "alert"}
        >
          {feedback.message}
        </p>
      )}
    </div>
  );
}

function ManagedAccountState({
  state,
  hasPairedInstances,
}: {
  readonly state: CtoxManagedState;
  readonly hasPairedInstances: boolean;
}) {
  const { refreshing, login, logout } = useCtoxMode();
  if (state === "loading") {
    return (
      <p className="text-sm text-sidebar-muted-foreground" role="status">
        Loading ctox.dev instances…
      </p>
    );
  }
  if (state === "signed_out") {
    return (
      <div className="rounded-lg border border-sidebar-border/70 bg-sidebar-accent/20 px-3 py-3">
        <p className="text-sm font-medium text-sidebar-foreground">Signed out of ctox.dev</p>
        <button
          type="button"
          className="mt-3 rounded-md bg-sidebar-primary px-3 py-1.5 text-xs font-medium text-sidebar-primary-foreground disabled:opacity-50"
          onClick={login}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          Sign in
        </button>
      </div>
    );
  }
  if (state === "failed") {
    return (
      <p
        className="rounded-lg border border-destructive/30 px-3 py-3 text-sm text-destructive"
        role="alert"
      >
        {hasPairedInstances
          ? "ctox.dev discovery failed. Paired instances remain available."
          : "ctox.dev discovery failed. Try refreshing."}
      </p>
    );
  }
  return (
    <button
      type="button"
      className="text-xs text-sidebar-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
      onClick={logout}
      disabled={refreshing}
    >
      Sign out
    </button>
  );
}

export function CtoxSidebarShell() {
  const { discovery, refreshing, bridge, refresh, removePairedInstance } = useCtoxMode();
  const [addOpen, setAddOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [mutationFeedback, setMutationFeedback] = useState<CtoxMutationOutcome | null>(null);
  const managedState = getCtoxManagedState(discovery);
  const readyInstances =
    discovery !== "loading" && discovery._tag === "ready" ? discovery.instances : [];
  const groups = groupCtoxInstances(readyInstances);
  const managed = groups.find((group) => group.key === "managed")!;
  const paired = groups.find((group) => group.key === "paired")!;
  const supplementalGroups = groups.filter(
    (group) => (group.key === "local" || group.key === "ssh") && group.instances.length > 0,
  );

  const remove = (instance: CtoxManagedInstance) => {
    setRemovingId(instance.id);
    setMutationFeedback(null);
    void removePairedInstance(instance)
      .then(setMutationFeedback)
      .finally(() => setRemovingId(null));
  };

  return (
    <>
      <SidebarChromeHeader isElectron />
      <SidebarContent className="gap-0" data-ctox-sidebar-shell="">
        <SidebarGroup className="px-[calc(var(--sidebar-content-inset)+0.5rem)] py-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-sidebar-foreground">CTOX instances</p>
            <button
              type="button"
              className="rounded-md border border-sidebar-border px-2 py-1 text-xs text-sidebar-foreground disabled:opacity-50"
              onClick={refresh}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              Refresh
            </button>
          </div>

          {bridge === undefined ? (
            <p
              className="mb-3 rounded-lg border border-sidebar-border/70 px-3 py-2 text-xs text-sidebar-muted-foreground"
              role="status"
            >
              CTOX desktop services are unavailable.
            </p>
          ) : null}

          {discovery !== "loading" && discovery._tag === "failed" ? (
            <p
              className="rounded-lg border border-destructive/30 px-3 py-3 text-sm text-destructive"
              role="alert"
            >
              CTOX instance discovery failed. Try refreshing.
            </p>
          ) : (
            <div className="space-y-4">
              <section aria-labelledby="ctox-managed-heading">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2
                    id="ctox-managed-heading"
                    className="text-xs font-medium uppercase tracking-wide text-sidebar-muted-foreground"
                  >
                    Managed
                  </h2>
                  {managedState === "ready" ? (
                    <ManagedAccountState
                      state={managedState}
                      hasPairedInstances={paired.instances.length > 0}
                    />
                  ) : null}
                </div>
                {managedState === "ready" ? (
                  managed.instances.length === 0 ? (
                    <p className="text-xs text-sidebar-muted-foreground" role="status">
                      No managed instances are available.
                    </p>
                  ) : (
                    <CtoxManagedInstanceList instances={managed.instances} />
                  )
                ) : (
                  <ManagedAccountState
                    state={managedState}
                    hasPairedInstances={paired.instances.length > 0}
                  />
                )}
              </section>

              <section aria-labelledby="ctox-paired-heading">
                <h2
                  id="ctox-paired-heading"
                  className="mb-2 text-xs font-medium uppercase tracking-wide text-sidebar-muted-foreground"
                >
                  Paired
                </h2>
                {discovery === "loading" ? (
                  <p className="text-xs text-sidebar-muted-foreground" role="status">
                    Loading paired instances…
                  </p>
                ) : paired.instances.length === 0 ? (
                  <p className="text-xs text-sidebar-muted-foreground" role="status">
                    No paired instances.
                  </p>
                ) : (
                  <>
                    <CtoxInstanceList
                      instances={paired.instances}
                      label="Paired CTOX instances"
                      removingId={removingId}
                      onRemove={remove}
                    />
                  </>
                )}
              </section>

              {supplementalGroups.map((group) => (
                <section key={group.key} aria-labelledby={`ctox-${group.key}-heading`}>
                  <h2
                    id={`ctox-${group.key}-heading`}
                    className="mb-2 text-xs font-medium uppercase tracking-wide text-sidebar-muted-foreground"
                  >
                    {group.label}
                  </h2>
                  <CtoxInstanceList
                    instances={group.instances}
                    label={`${group.label} CTOX instances`}
                  />
                </section>
              ))}
            </div>
          )}

          {mutationFeedback === null ? null : (
            <p
              className={cn(
                "mt-3 text-xs",
                mutationFeedback.ok ? "text-sidebar-foreground" : "text-destructive",
              )}
              role={mutationFeedback.ok ? "status" : "alert"}
            >
              {mutationFeedback.message}
            </p>
          )}

          {addOpen ? (
            <PairingAddSurface onClose={() => setAddOpen(false)} onImported={setMutationFeedback} />
          ) : (
            <button
              type="button"
              className="mt-4 w-full rounded-md border border-sidebar-border px-2 py-1.5 text-xs text-sidebar-foreground hover:bg-sidebar-accent/40 disabled:opacity-50"
              onClick={() => {
                setMutationFeedback(null);
                setAddOpen(true);
              }}
              disabled={bridge === undefined}
            >
              Add instance
            </button>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

export function resolveCtoxGuestBounds(
  rect: Pick<DOMRect, "bottom" | "left" | "right" | "top">,
): CtoxGuestBounds {
  const x = Math.max(0, Math.ceil(rect.left));
  const y = Math.max(0, Math.ceil(rect.top));
  const right = Math.max(x, Math.floor(rect.right));
  const bottom = Math.max(y, Math.floor(rect.bottom));
  return { x, y, width: right - x, height: bottom - y };
}

function boundsOf(element: HTMLElement): CtoxGuestBounds {
  return resolveCtoxGuestBounds(element.getBoundingClientRect());
}

export function retainCtoxGuestBounds(
  current: CtoxGuestBounds | null,
  next: CtoxGuestBounds,
): CtoxGuestBounds {
  return current !== null &&
    current.x === next.x &&
    current.y === next.y &&
    current.width === next.width &&
    current.height === next.height
    ? current
    : next;
}

export function claimCtoxGuestActivation(
  activatedKey: { current: number },
  activationKey: number,
): boolean {
  if (activatedKey.current === activationKey) return false;
  activatedKey.current = activationKey;
  return true;
}

interface CtoxGuestActivationState {
  readonly activationKey: number;
  readonly bridge: DesktopCtoxBridge | undefined;
  readonly instanceId: string;
  readonly modeReady: boolean;
  readonly selectedId: string | null;
}

export function isCurrentCtoxGuestActivation(
  mounted: boolean,
  current: CtoxGuestActivationState,
  expected: CtoxGuestActivationState,
): boolean {
  return (
    mounted &&
    current.activationKey === expected.activationKey &&
    current.bridge === expected.bridge &&
    current.instanceId === expected.instanceId &&
    current.modeReady === expected.modeReady &&
    current.selectedId === expected.selectedId
  );
}

export function trackCtoxGuestActivation(
  activation: Promise<CtoxManagedGuestResult>,
  isCurrent: () => boolean,
  setConnection: (state: CtoxConnectionState) => void,
): void {
  void activation.then(
    (result) => {
      if (!isCurrent()) return;
      if (result._tag === "ready") setConnection("ready");
      else if (result._tag === "revoked") setConnection("revoked");
      else setConnection("error");
    },
    () => {
      if (isCurrent()) setConnection("error");
    },
  );
}

function CtoxGuestHost({ instance }: { readonly instance: CtoxManagedInstance }) {
  const {
    bridge,
    activationKey,
    connection,
    modeReady,
    selectedId,
    setConnection,
    reportGuestBounds,
  } = useCtoxMode();
  const hostRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const activatedKeyRef = useRef(0);
  const activationStateRef = useRef({
    activationKey,
    bridge,
    instanceId: instance.id,
    modeReady,
    selectedId,
  });
  activationStateRef.current = {
    activationKey,
    bridge,
    instanceId: instance.id,
    modeReady,
    selectedId,
  };
  const [bounds, setBounds] = useState<CtoxGuestBounds | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof ResizeObserver === "undefined") return;
    const report = () => {
      const next = boundsOf(host);
      reportGuestBounds(next);
      setBounds((current) => retainCtoxGuestBounds(current, next));
    };
    const observer = new ResizeObserver(report);
    observer.observe(host);
    report();
    return () => observer.disconnect();
  }, [reportGuestBounds]);

  useEffect(() => {
    if (
      bounds === null ||
      bounds.width === 0 ||
      bounds.height === 0 ||
      !modeReady ||
      selectedId !== instance.id ||
      !claimCtoxGuestActivation(activatedKeyRef, activationKey)
    )
      return;
    const expectedActivation = {
      activationKey,
      bridge,
      instanceId: instance.id,
      modeReady,
      selectedId,
    };
    const activation = activateCtoxInstance(bridge, instance, bounds);
    if (activation === undefined) {
      setConnection("error");
      return;
    }
    trackCtoxGuestActivation(
      activation,
      () =>
        isCurrentCtoxGuestActivation(
          mountedRef.current,
          activationStateRef.current,
          expectedActivation,
        ),
      setConnection,
    );
  }, [activationKey, bounds, bridge, instance, modeReady, selectedId, setConnection]);

  useEffect(() => {
    if (bridge === undefined || bounds === null || connection !== "ready") return;
    void bridge.setGuestBounds(bounds).catch(() => undefined);
  }, [bounds, bridge, connection]);

  const fallback = {
    connecting: "Connecting to the Business OS guest…",
    ready: `Business OS guest for ${instance.displayName} is ready.`,
    error: "The Business OS guest could not be opened.",
    revoked: "Access to this instance is no longer available.",
    idle: "Select an instance to connect.",
  }[connection];

  return (
    <div
      ref={hostRef}
      className="relative min-h-0 flex-1 overflow-hidden bg-background"
      role="region"
      aria-label={`Business OS guest: ${instance.displayName}`}
      data-ctox-connection={connection}
      data-ctox-native-guest-host=""
    >
      <p
        className="absolute inset-0 grid place-items-center px-8 text-center text-sm text-muted-foreground"
        role="status"
      >
        {fallback}
      </p>
    </div>
  );
}

export function CtoxMainShell() {
  const { discovery, selectedId, connection } = useCtoxMode();
  const selected =
    discovery !== "loading" && discovery._tag === "ready"
      ? discovery.instances.find(
          (instance) => instance.id === selectedId && canActivateCtoxInstance(instance),
        )
      : undefined;

  const emptyState =
    connection === "revoked"
      ? {
          title: "Access revoked",
          description: "Access to the selected instance is no longer available.",
        }
      : discovery !== "loading" && discovery._tag === "failed"
        ? {
            title: "CTOX is unavailable",
            description: "Instance discovery could not be completed. Try refreshing the sidebar.",
          }
        : discovery === "loading"
          ? {
              title: "Loading CTOX instances",
              description: "Discovery is still in progress.",
            }
          : {
              title: "No instance selected",
              description: "Select an available instance from the sidebar to open Business OS.",
            };

  return (
    <SidebarInset
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
      data-ctox-main-shell=""
    >
      <header
        data-ctox-main-chrome=""
        className={cn(
          "workspace-topbar drag-region border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <span className="text-xs font-medium text-muted-foreground/60 wco:pr-[var(--workspace-native-controls-inset)]">
          {selected === undefined ? "CTOX" : selected.displayName}
        </span>
        {selected !== undefined ? (
          <span className="ml-auto text-xs text-muted-foreground" role="status">
            {connection}
          </span>
        ) : null}
      </header>
      {selected === undefined ? (
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-xl text-foreground">{emptyState.title}</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                {emptyState.description}
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      ) : (
        <CtoxGuestHost instance={selected} />
      )}
    </SidebarInset>
  );
}
