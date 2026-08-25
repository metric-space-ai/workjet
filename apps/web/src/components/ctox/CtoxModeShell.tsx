import type {
  CtoxDiscoveryResult,
  CtoxGuestBounds,
  CtoxGuestLifecycleState,
  CtoxGuestStateEvent,
  CtoxHostThemeTokenKey,
  CtoxInstanceApp,
  CtoxManagedGuestResult,
  CtoxManagedInstance,
  CtoxManagedInstanceSource,
  CtoxManualPairingImportInput,
  CtoxSshManagedInstanceAddInput,
  DesktopCtoxBridge,
} from "@t3tools/contracts";
import { CtoxHostThemeColor } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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

import { ChevronRight, Plus, RefreshCw, SettingsIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";

import {
  peekCrossModeBusinessOsRequest,
  subscribeToCrossModeBusinessOsRequest,
  takeCrossModeBusinessOsRequest,
  type CrossModeBusinessOsRequest,
} from "../../crossMode/crossModeBusinessOsHandoff";
import { crossModeSelectionMemory } from "../../crossMode/crossModeSelectionMemory";
import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";

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

export interface CtoxSshManagedFormValues {
  readonly host: string;
  readonly displayName: string;
  readonly stateRoot: string;
}

export const CTOX_IMPORT_SUCCESS_MESSAGE = "Instance added.";
export const CTOX_IMPORT_ERROR_MESSAGE =
  "Instance could not be added. Check the entry and try again.";
export const CTOX_REMOVE_SUCCESS_MESSAGE = "Paired instance removed.";
export const CTOX_REMOVE_ERROR_MESSAGE = "Paired instance could not be removed. Try again.";
export const CTOX_SSH_REMOVE_SUCCESS_MESSAGE = "SSH instance removed.";
export const CTOX_SSH_REMOVE_ERROR_MESSAGE = "SSH instance could not be removed. Try again.";
/**
 * SSH-managed instances are discovered and listed, but not launchable: the
 * remote daemon's signaling endpoints live on the remote loopback interface,
 * which the desktop cannot reach without an SSH port forward.
 */
export const CTOX_SSH_LAUNCH_PENDING_HINT = "This SSH host is not reachable right now.";

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

/** Topbar wording for the guest connection — the raw enum leaked before (K-B4). */
const CONNECTION_LABELS: Record<string, string> = {
  idle: "Idle",
  connecting: "Connecting…",
  ready: "Connected",
  error: "Connection error",
  revoked: "Access revoked",
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
  /** Per-instance native guest lifecycle, pushed by the desktop main process. */
  readonly guestStates: ReadonlyMap<string, CtoxGuestLifecycleState>;
  readonly refresh: () => void;
  readonly login: () => void;
  readonly logout: () => void;
  readonly importInvite: (invite: string) => Promise<CtoxMutationOutcome>;
  readonly importManualPairing: (
    input: CtoxManualPairingImportInput,
  ) => Promise<CtoxMutationOutcome>;
  readonly removePairedInstance: (instance: CtoxManagedInstance) => Promise<CtoxMutationOutcome>;
  readonly addSshManagedInstance: (
    input: CtoxSshManagedInstanceAddInput,
  ) => Promise<CtoxMutationOutcome>;
  readonly removeSshManagedInstance: (
    instance: CtoxManagedInstance,
  ) => Promise<CtoxMutationOutcome>;
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

export function isSshManagedCtoxInstance(instance: CtoxManagedInstance): boolean {
  return instance.source === "ssh_managed";
}

/** Instances the user configured themselves and may therefore remove again. */
export function isRemovableCtoxInstance(instance: CtoxManagedInstance): boolean {
  return isPairedCtoxInstance(instance) || isSshManagedCtoxInstance(instance);
}

export function canActivateCtoxInstance(instance: CtoxManagedInstance): boolean {
  if (instance.source === "ctox_dev") return instance.status === "available";
  // A local daemon is launchable exactly while it is answering: the main
  // process mints its pairing material from that daemon on every activation.
  if (instance.source === "local_daemon") return instance.status === "available";
  // An SSH-managed instance is launchable while its remote daemon answers:
  // the main process mints the invite over SSH and forwards the remote
  // signaling ports to local loopback (CtoxSshManagedLaunch).
  if (instance.source === "ssh_managed") return instance.status === "available";
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

export function buildCtoxSshManagedInput(
  values: CtoxSshManagedFormValues,
): CtoxSshManagedInstanceAddInput {
  return {
    host: values.host.trim(),
    ...(values.displayName.trim() === "" ? {} : { displayName: values.displayName.trim() }),
    ...(values.stateRoot.trim() === "" ? {} : { stateRoot: values.stateRoot.trim() }),
  };
}

export async function submitCtoxSshManagedInstance(
  bridge: DesktopCtoxBridge | undefined,
  input: CtoxSshManagedInstanceAddInput,
): Promise<CtoxMutationOutcome> {
  if (bridge === undefined) return { ok: false, message: CTOX_IMPORT_ERROR_MESSAGE };
  try {
    const result = await bridge.addSshManagedInstance(input);
    return result._tag === "completed"
      ? { ok: true, message: CTOX_IMPORT_SUCCESS_MESSAGE }
      : { ok: false, message: CTOX_IMPORT_ERROR_MESSAGE };
  } catch {
    return { ok: false, message: CTOX_IMPORT_ERROR_MESSAGE };
  }
}

export async function removeCtoxSshManagedInstance(
  bridge: DesktopCtoxBridge | undefined,
  instance: CtoxManagedInstance,
): Promise<CtoxMutationOutcome> {
  if (bridge === undefined || !isSshManagedCtoxInstance(instance)) {
    return { ok: false, message: CTOX_SSH_REMOVE_ERROR_MESSAGE };
  }
  try {
    const result = await bridge.removeSshManagedInstance(instance.id);
    return result._tag === "completed"
      ? { ok: true, message: CTOX_SSH_REMOVE_SUCCESS_MESSAGE }
      : { ok: false, message: CTOX_SSH_REMOVE_ERROR_MESSAGE };
  } catch {
    return { ok: false, message: CTOX_SSH_REMOVE_ERROR_MESSAGE };
  }
}

/**
 * What a pending cross-mode request resolves to against the instances this
 * shell currently knows about, or `null` when it cannot be honoured yet.
 *
 * Pure so the decision is testable: the effect that consumes it runs only in a
 * real renderer, and the interesting cases are all about NOT acting — an
 * instance that has not been discovered yet, or one that cannot be activated,
 * must leave the request pending rather than drop it.
 */
export function resolveCrossModeBusinessOsActivation(
  request: CrossModeBusinessOsRequest | null,
  instances: readonly CtoxManagedInstance[],
): { readonly instance: CtoxManagedInstance; readonly moduleId?: string } | null {
  if (request === null) return null;
  const instance = instances.find((candidate) => candidate.id === request.instanceId);
  if (instance === undefined || !canActivateCtoxInstance(instance)) return null;
  return request.moduleId === undefined ? { instance } : { instance, moduleId: request.moduleId };
}

export function releaseCtoxGuest(bridge: DesktopCtoxBridge | undefined): void {
  void bridge?.deactivate().catch(() => undefined);
}

export function releaseCtoxMode(bridge: DesktopCtoxBridge | undefined): void {
  void bridge?.exitBusinessOsMode().catch(() => undefined);
}

const EMPTY_GUEST_STATES: ReadonlyMap<string, CtoxGuestLifecycleState> = new Map();

/**
 * Folds one guest-state event into the per-instance map. "none" removes the
 * entry (absence IS the none state), and an unchanged state returns the same
 * map identity so subscribers can skip re-rendering.
 */
export function applyCtoxGuestStateEvent(
  current: ReadonlyMap<string, CtoxGuestLifecycleState>,
  event: CtoxGuestStateEvent,
): ReadonlyMap<string, CtoxGuestLifecycleState> {
  const existing = current.get(event.instanceId);
  if (event.state === "none") {
    if (existing === undefined) return current;
    const next = new Map(current);
    next.delete(event.instanceId);
    return next;
  }
  if (existing === event.state) return current;
  const next = new Map(current);
  next.set(event.instanceId, event.state);
  return next;
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
  const [guestStates, setGuestStates] = useState(EMPTY_GUEST_STATES);
  const mountedRef = useRef(true);
  const selectedIdRef = useRef<string | null>(null);

  // The desktop main process owns the guest pool; the sidebar dots follow its
  // per-instance lifecycle events (instance id + state token, nothing else).
  useEffect(() => {
    const subscribeToGuestState = bridge?.onGuestState;
    if (subscribeToGuestState === undefined) return;
    const unsubscribe = subscribeToGuestState((event) => {
      if (!mountedRef.current) return;
      setGuestStates((current) => applyCtoxGuestStateEvent(current, event));
    });
    return () => {
      unsubscribe();
      setGuestStates(EMPTY_GUEST_STATES);
    };
  }, [bridge]);

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

  const addSshManagedInstance = useCallback(
    async (input: CtoxSshManagedInstanceAddInput) => {
      const outcome = await submitCtoxSshManagedInstance(bridge, input);
      if (outcome.ok) refresh();
      return outcome;
    },
    [bridge, refresh],
  );

  const removeSshManagedInstance = useCallback(
    async (instance: CtoxManagedInstance) => {
      const outcome = await removeCtoxSshManagedInstance(bridge, instance);
      if (!outcome.ok) return outcome;
      if (selectedIdRef.current === instance.id) clearSelection("idle");
      refresh();
      return outcome;
    },
    [bridge, clearSelection, refresh],
  );

  const select = useCallback((instance: CtoxManagedInstance) => {
    if (!canActivateCtoxInstance(instance)) return;
    // Re-selecting the already-connected instance must not tear the guest
    // down; the row click then only surfaces the instance and its apps.
    if (selectedIdRef.current === instance.id) return;
    selectedIdRef.current = instance.id;
    setSelectedId(instance.id);
    setActivationKey((current) => current + 1);
    setConnection("connecting");
    // Keep the cross-mode memory current so leaving for Code and coming back
    // lands on this instance again. An instance id only — the guest's data
    // never leaves the guest.
    crossModeSelectionMemory.remember({ mode: "business-os", ctoxInstanceId: instance.id });
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
    // Theme edits made while the guest was closed leave no <html> attribute
    // mutation behind, so re-project the current appearance on every ready
    // transition instead of trusting the observer alone.
    pushHostThemeRef.current();
    const pending = pendingOpenRef.current;
    if (pending === null || pending.instanceId !== selectedIdRef.current) return;
    pendingOpenRef.current = null;
    dispatchOpenApp(pending.instanceId, pending.moduleId);
  }, [connection, dispatchOpenApp]);

  // A cross-mode link that arrives while Code mode is showing cannot be acted
  // on immediately: this provider does not exist yet. The link navigator
  // therefore files the request in `crossModeBusinessOsHandoff` AFTER it has
  // released the Code surface and switched the mode, and this effect is the
  // only thing that honours it — which is what keeps "the guest is never
  // created while Code is still up" true rather than merely likely.
  //
  // The request is one-shot and is taken only once its instance is present and
  // activatable, so a link naming an instance that is still loading waits for
  // the next discovery instead of being dropped, and a stale request can never
  // re-select an instance the user has since left.
  useEffect(() => {
    if (discovery === "loading" || discovery._tag !== "ready") return;
    const instances = discovery.instances;
    const honourPendingRequest = () => {
      const activation = resolveCrossModeBusinessOsActivation(
        peekCrossModeBusinessOsRequest(),
        instances,
      );
      if (activation === null) return;
      takeCrossModeBusinessOsRequest();
      if (activation.moduleId === undefined) select(activation.instance);
      else openApp(activation.instance, activation.moduleId);
    };
    // Subscribe first: a request filed between the two calls still lands.
    const unsubscribe = subscribeToCrossModeBusinessOsRequest(honourPendingRequest);
    honourPendingRequest();
    return unsubscribe;
  }, [discovery, openApp, select]);

  const pushHostThemeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (bridge === undefined || typeof window === "undefined") return;
    const pushHostTheme = () => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);
      // Theme tokens may be color-mix()/var() expressions; the bridge accepts
      // only bounded concrete colors, so resolve each through a probe element
      // and drop anything that still fails the shared schema.
      const probe = document.createElement("span");
      probe.style.display = "none";
      document.body.appendChild(probe);
      const pick = (name: string) => {
        const raw = styles.getPropertyValue(name).trim();
        if (raw === "") return "";
        probe.style.color = "";
        probe.style.color = raw;
        if (probe.style.color === "") return "";
        return getComputedStyle(probe).color.trim();
      };
      const tokens: { [K in CtoxHostThemeTokenKey]?: string } = {};
      const assign = (key: CtoxHostThemeTokenKey, value: string) => {
        if (value !== "" && Schema.is(CtoxHostThemeColor)(value)) tokens[key] = value;
      };
      assign("bg", pick("--background"));
      assign("surface", pick("--card"));
      assign("surface-2", pick("--secondary"));
      assign("surface-3", pick("--popover"));
      assign("line", pick("--border"));
      assign("hairline", pick("--border"));
      assign("text", pick("--foreground"));
      assign("text-strong", pick("--foreground"));
      assign("muted", pick("--muted-foreground"));
      assign("accent", pick("--primary"));
      assign("accent-foreground", pick("--primary-foreground"));
      assign("accent-soft", pick("--accent"));
      probe.remove();
      void bridge
        .setHostTheme({
          scheme: root.classList.contains("dark") ? "dark" : "light",
          tokens,
        })
        .catch(() => undefined);
    };
    pushHostThemeRef.current = pushHostTheme;
    pushHostTheme();
    // Appearance changes rewrite class/data attributes on <html>.
    const observer = new MutationObserver(pushHostTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    return () => observer.disconnect();
  }, [bridge]);

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
      guestStates,
      refresh,
      login,
      logout,
      importInvite,
      importManualPairing,
      removePairedInstance,
      addSshManagedInstance,
      removeSshManagedInstance,
      select,
      setConnection,
      openApp,
      setAppDocked,
      appRailVersion,
      reportGuestBounds,
    }),
    [
      activationKey,
      addSshManagedInstance,
      appRailVersion,
      bridge,
      connection,
      discovery,
      guestStates,
      importInvite,
      importManualPairing,
      login,
      logout,
      modeReady,
      openApp,
      refresh,
      refreshing,
      removePairedInstance,
      removeSshManagedInstance,
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
/**
 * Two-step destructive TEXT button for the sidebar: the first click arms it
 * (label turns into a red question), the second within 4s fires. The settings
 * surfaces got this discipline in the click-review; removing an instance or
 * signing out destroys visible state just the same (Befunde K-B2/K-B3).
 */
function ConfirmingTextAction({
  label,
  confirmLabel,
  ariaLabel,
  className,
  disabled,
  busy,
  onConfirm,
}: {
  readonly label: string;
  readonly confirmLabel: string;
  /** Screen-reader name; stays instance-specific while the visible text is short. */
  readonly ariaLabel: string;
  readonly className: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4_000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      className={cn(className, armed && "visible font-medium text-destructive")}
      disabled={disabled}
      aria-busy={busy}
      aria-label={armed ? `Confirm: ${ariaLabel}` : ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

function CtoxInstanceAppRail({
  instance,
  launchable,
  onWorkspaceName,
}: {
  readonly instance: CtoxManagedInstance;
  readonly launchable: boolean;
  readonly onWorkspaceName?: (name: string) => void;
}) {
  const { bridge, selectedId, connection, openApp, setAppDocked, appRailVersion } = useCtoxMode();
  const [apps, setApps] = useState<readonly CtoxInstanceApp[]>([]);
  const [source, setSource] = useState<"live" | "cache">("cache");
  const instanceReady = selectedId === instance.id && connection === "ready";

  useEffect(() => {
    if (bridge === undefined) return;
    let cancelled = false;
    const load = () => {
      void bridge.listApps(instance.id).then(
        (result) => {
          if (cancelled || result._tag !== "completed") return;
          setApps(result.apps);
          setSource(result.source);
          if (result.workspaceName !== undefined) onWorkspaceName?.(result.workspaceName);
        },
        () => undefined,
      );
    };
    load();
    // The guest navigates internally without notifying the renderer, so a
    // connected instance polls its rail to pick up newly opened modules.
    const interval = instanceReady ? setInterval(load, 8_000) : undefined;
    return () => {
      cancelled = true;
      if (interval !== undefined) clearInterval(interval);
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

/** Apps whose guest module declares no category still need one bucket. */
export const CTOX_RAIL_FALLBACK_CATEGORY = "Apps";
/** How many apps of an expanded category are shown before "Show more". */
export const CTOX_RAIL_CATEGORY_PREVIEW_COUNT = 5;

export interface CtoxRailCategoryGroup {
  readonly category: string;
  readonly apps: readonly CtoxInstanceApp[];
}

function appLabel(app: CtoxInstanceApp): string {
  return app.title ?? app.id;
}

/** Open first, then alphabetically by visible label; the id breaks ties. */
function compareRailApps(a: CtoxInstanceApp, b: CtoxInstanceApp): number {
  if (a.open !== b.open) return a.open ? -1 : 1;
  const byLabel = appLabel(a).localeCompare(appLabel(b), "en", { sensitivity: "base" });
  return byLabel !== 0 ? byLabel : a.id.localeCompare(b.id);
}

/**
 * Taskbar model: docked apps stay pinned at the top in their pin order and are
 * never grouped or hidden. Everything else is bucketed by the guest module's
 * own category, categories holding an open app first, then alphabetically.
 */
export function groupCtoxRailApps(apps: readonly CtoxInstanceApp[]): {
  readonly docked: readonly CtoxInstanceApp[];
  readonly categories: readonly CtoxRailCategoryGroup[];
} {
  const docked = apps.filter((app) => app.docked);
  const buckets = new Map<string, CtoxInstanceApp[]>();
  for (const app of apps) {
    if (app.docked) continue;
    const category = app.category ?? CTOX_RAIL_FALLBACK_CATEGORY;
    const bucket = buckets.get(category);
    if (bucket === undefined) buckets.set(category, [app]);
    else bucket.push(app);
  }
  const categories = [...buckets.entries()]
    .map(([category, bucket]) => ({ category, apps: [...bucket].sort(compareRailApps) }))
    .sort((a, b) => {
      const aOpen = a.apps.some((app) => app.open);
      const bOpen = b.apps.some((app) => app.open);
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      return a.category.localeCompare(b.category, "en", { sensitivity: "base" });
    });
  return { docked, categories };
}

/**
 * The preview slice of an expanded category. Apps are already open-first, and
 * the slice grows past the preview count when needed so that an open app can
 * never end up hidden behind "Show more".
 */
export function visibleCtoxRailApps(
  apps: readonly CtoxInstanceApp[],
  expanded: boolean,
): readonly CtoxInstanceApp[] {
  if (expanded) return apps;
  const openCount = apps.filter((app) => app.open).length;
  return apps.slice(0, Math.max(CTOX_RAIL_CATEGORY_PREVIEW_COUNT, openCount));
}

/** Bounded, per-instance and per-category localStorage key for collapse state. */
export function ctoxRailCollapseKey(instanceId: string, category: string): string {
  return `ctox.rail.collapsed:${instanceId.slice(0, 128)}:${category.slice(0, 64)}`;
}

/**
 * Reading `localStorage` can throw (blocked storage, SSR); collapse state is
 * cosmetic, so every failure silently falls back to the expanded default.
 */
function railCollapseStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readCtoxRailCollapsed(
  instanceId: string,
  category: string,
  storage: Storage | undefined = railCollapseStorage(),
): boolean {
  try {
    return storage?.getItem(ctoxRailCollapseKey(instanceId, category)) === "1";
  } catch {
    return false;
  }
}

export function writeCtoxRailCollapsed(
  instanceId: string,
  category: string,
  collapsed: boolean,
  storage: Storage | undefined = railCollapseStorage(),
): void {
  const key = ctoxRailCollapseKey(instanceId, category);
  try {
    if (collapsed) storage?.setItem(key, "1");
    else storage?.removeItem(key);
  } catch {
    // A full or blocked store must never break the rail.
  }
}

function CtoxAppRailRow({
  app,
  instanceReady,
  stale,
  launchable,
  onOpen,
  onToggleDock,
}: {
  readonly app: CtoxInstanceApp;
  readonly instanceReady: boolean;
  readonly stale: boolean;
  readonly launchable: boolean;
  readonly onOpen: (moduleId: string) => void;
  readonly onToggleDock: (moduleId: string, docked: boolean) => void;
}) {
  const open = app.open && instanceReady;
  return (
    <li className="group/ctox-app flex items-center gap-1">
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
        <span className="truncate">{appLabel(app)}</span>
      </button>
      <button
        type="button"
        className="invisible shrink-0 rounded p-1 text-[10px] text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:visible group-hover/ctox-app:visible"
        title={app.docked ? "Undock app" : "Dock app"}
        aria-label={`${app.docked ? "Undock" : "Dock"} ${appLabel(app)}`}
        onClick={() => onToggleDock(app.id, !app.docked)}
      >
        {app.docked ? "Unpin" : "Pin"}
      </button>
    </li>
  );
}

function CtoxAppRailCategory({
  instance,
  group,
  instanceReady,
  stale,
  launchable,
  onOpen,
  onToggleDock,
}: {
  readonly instance: CtoxManagedInstance;
  readonly group: CtoxRailCategoryGroup;
  readonly instanceReady: boolean;
  readonly stale: boolean;
  readonly launchable: boolean;
  readonly onOpen: (moduleId: string) => void;
  readonly onToggleDock: (moduleId: string, docked: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(() =>
    readCtoxRailCollapsed(instance.id, group.category),
  );
  const [expanded, setExpanded] = useState(false);
  const visible = visibleCtoxRailApps(group.apps, expanded);
  const hidden = group.apps.length - visible.length;
  return (
    <li data-ctox-app-category={group.category}>
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-sidebar-muted-foreground transition-colors hover:text-sidebar-foreground"
        aria-expanded={!collapsed}
        data-ctox-app-category-collapsed={collapsed}
        onClick={() => {
          const next = !collapsed;
          setCollapsed(next);
          writeCtoxRailCollapsed(instance.id, group.category, next);
        }}
      >
        <span aria-hidden className={cn("shrink-0 text-[8px]", collapsed ? "" : "rotate-90")}>
          ▶
        </span>
        <span className="truncate">{group.category}</span>
        <span className="text-sidebar-muted-foreground/70">{group.apps.length}</span>
      </button>
      {collapsed ? null : (
        <ul className="space-y-0.5">
          {visible.map((app) => (
            <CtoxAppRailRow
              key={app.id}
              app={app}
              instanceReady={instanceReady}
              stale={stale}
              launchable={launchable}
              onOpen={onOpen}
              onToggleDock={onToggleDock}
            />
          ))}
          {hidden > 0 || expanded ? (
            <li>
              <button
                type="button"
                className="w-full rounded px-2 py-1 text-left text-[11px] text-sidebar-muted-foreground transition-colors hover:text-sidebar-foreground"
                data-ctox-app-category-more={group.category}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Show less" : `Show more (${hidden})`}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </li>
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
  const { docked, categories } = groupCtoxRailApps(apps);
  return (
    <ul className="space-y-0.5 py-0.5 pl-4" aria-label={`Apps of ${instance.displayName}`}>
      {docked.map((app) => (
        <CtoxAppRailRow
          key={app.id}
          app={app}
          instanceReady={instanceReady}
          stale={stale}
          launchable={launchable}
          onOpen={onOpen}
          onToggleDock={onToggleDock}
        />
      ))}
      {categories.map((group) => (
        <CtoxAppRailCategory
          key={group.category}
          instance={instance}
          group={group}
          instanceReady={instanceReady}
          stale={stale}
          launchable={launchable}
          onOpen={onOpen}
          onToggleDock={onToggleDock}
        />
      ))}
    </ul>
  );
}

/**
 * Why a listed instance cannot be opened. A local daemon is only listed as
 * unavailable while it is not answering on this machine; once it runs it opens
 * like any other instance.
 */
export function unavailableHint(instance: CtoxManagedInstance): string | undefined {
  if (instance.source === "local_daemon") return "This local daemon is not running.";
  if (instance.source === "ssh_managed") {
    return instance.status === "available" ? undefined : CTOX_SSH_LAUNCH_PENDING_HINT;
  }
  return isPairedCtoxInstance(instance) ? "This pairing is not available." : undefined;
}

/**
 * Connection dot color, project-row style: state at a glance, detail in the
 * tooltip. The guest lifecycle wins over the discovery status — a warm guest
 * switches instantly (green), a loading one is on its first load (pulsing
 * amber), and only a guest-less instance falls back to its discovery status.
 */
export function ctoxInstanceDotClass(
  instance: CtoxManagedInstance,
  connected: boolean,
  guestState: CtoxGuestLifecycleState = "none",
): string {
  if (connected || guestState === "warm") return "bg-emerald-500";
  if (guestState === "loading") return "animate-pulse bg-amber-500/90";
  if (instance.status === "error" || instance.status === "offline") return "bg-red-500/80";
  if (
    instance.status === "needs_auth" ||
    instance.status === "pairing_expired" ||
    instance.status === "installing"
  )
    return "bg-amber-500/90";
  return "bg-sidebar-muted-foreground/50";
}

function CtoxInstanceCard({
  instance,
  removingId,
  onRemove,
}: {
  readonly instance: CtoxManagedInstance;
  readonly removingId?: string | null | undefined;
  readonly onRemove?: ((instance: CtoxManagedInstance) => void) | undefined;
}) {
  const { selectedId, connection, guestStates, select } = useCtoxMode();
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  // Collapse is per-card UI state (defect 16): the chevron folds the app tree
  // without touching the selection; selecting always re-expands.
  const [collapsed, setCollapsed] = useState(false);
  const selected = selectedId === instance.id;
  const busy = selected && connection === "connecting";
  const connected = selected && connection === "ready";
  const guestState = guestStates.get(instance.id) ?? "none";
  const launchable = canActivateCtoxInstance(instance);
  const removable = isRemovableCtoxInstance(instance);
  const title = workspaceName ?? instance.displayName;

  useEffect(() => {
    // The selected instance's tree stays visible however the selection was
    // reached (row click, cross-mode handoff, app open).
    if (selected) setCollapsed(false);
  }, [selected]);
  const meta = [SOURCE_LABELS[instance.source], instance.role, instance.domain]
    .filter(Boolean)
    .join(" · ");
  const detailTitle = [
    workspaceName === null ? undefined : instance.displayName,
    meta,
    statusLabel(instance),
    launchable ? undefined : unavailableHint(instance),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className={cn("group/ctox-instance", !launchable && "opacity-70")}>
      <div className="flex items-center">
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-sidebar-muted-foreground transition-colors hover:text-sidebar-foreground"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} apps of ${title}`}
          data-ctox-instance-collapse=""
          data-ctox-instance-collapsed={collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 transition-transform motion-reduce:transition-none",
              !collapsed && "rotate-90",
            )}
          />
        </button>
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
            selected
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground",
            launchable ? "hover:bg-sidebar-accent/40" : "cursor-not-allowed",
          )}
          aria-pressed={selected}
          aria-busy={busy}
          data-ctox-instance-source={instance.source}
          data-ctox-instance-status={instance.status}
          data-ctox-guest-state={guestState}
          disabled={!launchable || busy}
          title={detailTitle}
          onClick={() => {
            // Selecting is a separate affordance from collapsing: the name
            // click selects AND expands; only the chevron folds the tree.
            setCollapsed(false);
            select(instance);
          }}
        >
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              ctoxInstanceDotClass(instance, connected, guestState),
            )}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        </button>
        {removable && onRemove !== undefined ? (
          <ConfirmingTextAction
            label="Remove"
            confirmLabel="Remove?"
            ariaLabel={`Remove ${title}`}
            className="invisible shrink-0 rounded p-1 text-[10px] text-sidebar-muted-foreground group-hover/ctox-instance:visible hover:text-sidebar-foreground focus-visible:visible disabled:opacity-50"
            disabled={removingId === instance.id}
            busy={removingId === instance.id}
            onConfirm={() => onRemove(instance)}
          />
        ) : null}
      </div>
      {collapsed ? null : (
        <CtoxInstanceAppRail
          instance={instance}
          launchable={launchable}
          onWorkspaceName={setWorkspaceName}
        />
      )}
    </div>
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
  return (
    <div className="space-y-2" aria-label={label}>
      {instances.map((instance) => (
        <CtoxInstanceCard
          key={instance.id}
          instance={instance}
          removingId={removingId}
          onRemove={onRemove}
        />
      ))}
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

/** Exported for presentational tests; the sidebar renders it on demand. */
export function PairingAddSurface({
  onClose,
  onImported,
}: {
  readonly onClose: () => void;
  readonly onImported: (outcome: CtoxMutationOutcome) => void;
}) {
  const { importInvite, importManualPairing, addSshManagedInstance } = useCtoxMode();
  const [choice, setChoice] = useState<"invite" | "manual" | "ssh">("invite");
  const [invite, setInvite] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshDisplayName, setSshDisplayName] = useState("");
  const [sshStateRoot, setSshStateRoot] = useState("");
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
    setSshHost("");
    setSshDisplayName("");
    setSshStateRoot("");
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

  const submitSsh = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    void addSshManagedInstance(
      buildCtoxSshManagedInput({
        host: sshHost,
        displayName: sshDisplayName,
        stateRoot: sshStateRoot,
      }),
    )
      .then(finish)
      .finally(() => setSubmitting(false));
  };

  const choose = (next: "invite" | "manual" | "ssh") => {
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
      <div className="mt-2 grid grid-cols-3 gap-1 rounded-md bg-sidebar-accent/30 p-1">
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
        <button
          type="button"
          className={cn(
            "rounded px-2 py-1 text-xs",
            choice === "ssh"
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-muted-foreground",
          )}
          aria-pressed={choice === "ssh"}
          onClick={() => choose("ssh")}
        >
          SSH
        </button>
      </div>

      {choice === "ssh" ? (
        <form className="mt-3 space-y-2" onSubmit={submitSsh}>
          <label className="block text-xs text-sidebar-muted-foreground">
            SSH host or alias
            <input
              className={fieldClassName}
              value={sshHost}
              onChange={(event) => setSshHost(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="build-box"
              required
              maxLength={255}
            />
          </label>
          <label className="block text-xs text-sidebar-muted-foreground">
            Display name (optional)
            <input
              className={fieldClassName}
              value={sshDisplayName}
              onChange={(event) => setSshDisplayName(event.target.value)}
              autoComplete="off"
              maxLength={256}
            />
          </label>
          <label className="block text-xs text-sidebar-muted-foreground">
            CTOX state root on that host (optional)
            <input
              className={fieldClassName}
              value={sshStateRoot}
              onChange={(event) => setSshStateRoot(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="/home/you/.local/state/ctox"
              maxLength={1_024}
            />
          </label>
          <p className="text-[11px] leading-snug text-sidebar-muted-foreground">
            Uses your existing SSH configuration and keys. No credential is stored here.
          </p>
          <button
            type="submit"
            className="rounded-md bg-sidebar-primary px-3 py-1.5 text-xs font-medium text-sidebar-primary-foreground disabled:opacity-50"
            disabled={submitting}
            aria-busy={submitting}
          >
            Add SSH instance
          </button>
        </form>
      ) : choice === "invite" ? (
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
      <div className="flex items-center justify-between gap-2 px-2 py-1">
        <p className="truncate text-xs text-sidebar-muted-foreground">Signed out of ctox.dev</p>
        <button
          type="button"
          className="shrink-0 text-xs font-medium text-sidebar-primary underline-offset-2 hover:underline disabled:opacity-50"
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
      <p className="px-2 py-1 text-xs text-destructive" role="alert">
        {hasPairedInstances
          ? "ctox.dev discovery failed. Paired instances remain available."
          : "ctox.dev discovery failed. Try refreshing."}
      </p>
    );
  }
  return (
    <ConfirmingTextAction
      label="Sign out"
      confirmLabel="Sign out?"
      ariaLabel="Sign out"
      className="text-xs text-sidebar-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
      disabled={refreshing}
      onConfirm={logout}
    />
  );
}

/**
 * The Business OS sidebar footer strip. Code mode's footer navigates to
 * thread-scoped pages (Usage, Machines, Pull Requests) that the Business OS
 * main surface never renders, so those would be dead icons here and are
 * hidden. What remains is what has a BOS meaning: Settings (a real route that
 * swaps the whole shell) and refreshing the instance catalog.
 */
export function CtoxSidebarFooter() {
  const { refresh, refreshing } = useCtoxMode();
  // Resolved leniently so the shell can render outside a RouterProvider
  // (tests, storybook-style harnesses); without a router the Settings button
  // simply has nowhere to go and stays inert.
  const router = useRouter({ warn: false });
  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]" data-ctox-sidebar-footer="">
      <SidebarMenu className="flex-row items-center">
        <SidebarMenuItem className="shrink-0">
          <SidebarMenuButton
            aria-label="Settings"
            size="icon"
            title="Settings"
            onClick={() => {
              void router?.navigate({ to: "/settings" });
            }}
          >
            <SettingsIcon />
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem className="shrink-0">
          <SidebarMenuButton
            aria-label="Refresh instances"
            size="icon"
            title="Refresh instances"
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshCw className={cn(refreshing && "animate-spin")} aria-hidden />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

export function CtoxSidebarShell() {
  const { discovery, refreshing, bridge, refresh, removePairedInstance, removeSshManagedInstance } =
    useCtoxMode();
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
    const removal = isSshManagedCtoxInstance(instance)
      ? removeSshManagedInstance(instance)
      : removePairedInstance(instance);
    void removal.then(setMutationFeedback).finally(() => setRemovingId(null));
  };

  return (
    <>
      <SidebarChromeHeader isElectron />
      <SidebarContent className="gap-0" data-ctox-sidebar-shell="">
        <SidebarGroup className="px-[calc(var(--sidebar-content-inset)+0.5rem)] py-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-sidebar-foreground">CTOX instances</p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded-md p-1 text-sidebar-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-sidebar-foreground disabled:opacity-50"
                onClick={refresh}
                disabled={refreshing}
                aria-busy={refreshing}
                aria-label="Refresh instances"
                title="Refresh"
              >
                <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
              </button>
              <button
                type="button"
                className="rounded-md p-1 text-sidebar-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-sidebar-foreground disabled:opacity-50"
                onClick={() => {
                  setMutationFeedback(null);
                  setAddOpen((open) => !open);
                }}
                disabled={bridge === undefined}
                aria-label="Add instance"
                aria-expanded={addOpen}
                title="Add instance"
              >
                <Plus className="size-3.5" aria-hidden />
              </button>
            </div>
          </div>

          {bridge === undefined ? (
            <p className="mb-3 text-xs text-sidebar-muted-foreground" role="status">
              CTOX desktop services are unavailable.
            </p>
          ) : null}

          {discovery !== "loading" && discovery._tag === "failed" ? (
            <p className="text-xs text-destructive" role="alert">
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
                    {...(group.key === "ssh" ? { removingId, onRemove: remove } : {})}
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
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <CtoxSidebarFooter />
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
  const { discovery, selectedId, connection, guestStates } = useCtoxMode();
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

  // Business OS brings its own full shell header; while the guest is ready
  // the Workjet chrome row would just double it, so it collapses entirely and
  // the guest surface takes the full height. It returns for cold connects and
  // error states, which need the status line (and a drag region) anyway — but
  // NOT for a switch onto a warm guest: that attach is instant, and flashing
  // the chrome row would be the visible "load" defect 14 forbids.
  const chromeHidden =
    selected !== undefined &&
    (connection === "ready" ||
      (connection === "connecting" && guestStates.get(selected.id) === "warm"));

  return (
    <SidebarInset
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
      data-ctox-main-shell=""
    >
      {chromeHidden ? null : (
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
              {CONNECTION_LABELS[connection] ?? connection}
            </span>
          ) : null}
        </header>
      )}
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
