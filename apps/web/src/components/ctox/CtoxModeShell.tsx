import type {
  CtoxDiscoveryResult,
  CtoxGuestBounds,
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

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
      releaseCtoxGuest(bridge);
    };
  }, [bridge, refresh]);

  const value = useMemo<CtoxModeContextValue>(
    () => ({
      discovery,
      refreshing,
      selectedId,
      activationKey,
      connection,
      bridge,
      refresh,
      login,
      logout,
      importInvite,
      importManualPairing,
      removePairedInstance,
      select,
      setConnection,
    }),
    [
      activationKey,
      bridge,
      connection,
      discovery,
      importInvite,
      importManualPairing,
      login,
      logout,
      refresh,
      refreshing,
      removePairedInstance,
      select,
      selectedId,
    ],
  );

  return <CtoxModeContext value={value}>{children}</CtoxModeContext>;
}

function statusLabel(instance: CtoxManagedInstance): string {
  const health = instance.healthSummary.dataPlaneReady ? "WebRTC ready" : "WebRTC unavailable";
  return `${STATUS_LABELS[instance.status]} · ${health}`;
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

function boundsOf(element: HTMLElement): CtoxGuestBounds {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}

function CtoxGuestHost({ instance }: { readonly instance: CtoxManagedInstance }) {
  const { bridge, activationKey, connection, selectedId, setConnection } = useCtoxMode();
  const hostRef = useRef<HTMLDivElement>(null);
  const activatedKeyRef = useRef(0);
  const [bounds, setBounds] = useState<CtoxGuestBounds | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof ResizeObserver === "undefined") return;
    const report = () => setBounds(boundsOf(host));
    const observer = new ResizeObserver(report);
    observer.observe(host);
    report();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (bounds === null || selectedId === null || activatedKeyRef.current === activationKey) return;
    activatedKeyRef.current = activationKey;
    const activation = activateCtoxInstance(bridge, instance, bounds);
    if (activation === undefined) {
      setConnection("error");
      return;
    }
    let cancelled = false;
    void activation.then(
      (result) => {
        if (cancelled) return;
        if (result._tag === "ready") setConnection("ready");
        else if (result._tag === "revoked") setConnection("revoked");
        else setConnection("error");
      },
      () => {
        if (!cancelled) setConnection("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activationKey, bounds, bridge, instance, selectedId, setConnection]);

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
