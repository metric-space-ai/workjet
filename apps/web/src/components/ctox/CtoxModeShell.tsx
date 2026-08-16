import type {
  CtoxGuestBounds,
  CtoxManagedDiscoveryResult,
  CtoxManagedInstance,
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
  type ReactNode,
} from "react";

import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { cn } from "../../lib/utils";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarContent, SidebarGroup, SidebarInset } from "../ui/sidebar";

interface CtoxModeContextValue {
  readonly discovery: "loading" | CtoxManagedDiscoveryResult;
  readonly refreshing: boolean;
  readonly selectedId: string | null;
  readonly activationKey: number;
  readonly connection: "idle" | "connecting" | "ready" | "error" | "revoked";
  readonly bridge: DesktopCtoxBridge | undefined;
  readonly refresh: () => void;
  readonly login: () => void;
  readonly logout: () => void;
  readonly select: (instance: CtoxManagedInstance) => void;
  readonly setConnection: (state: CtoxModeContextValue["connection"]) => void;
}

const CtoxModeContext = createContext<CtoxModeContextValue | null>(null);

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
  readonly initialDiscovery?: "loading" | CtoxManagedDiscoveryResult;
  readonly bridge?: DesktopCtoxBridge;
}) {
  const [discovery, setDiscovery] = useState<"loading" | CtoxManagedDiscoveryResult>(
    initialDiscovery,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activationKey, setActivationKey] = useState(0);
  const [connection, setConnection] = useState<CtoxModeContextValue["connection"]>("idle");
  const mountedRef = useRef(true);
  const selectedIdRef = useRef<string | null>(null);

  const applyDiscovery = useCallback(
    (next: CtoxManagedDiscoveryResult) => {
      if (!mountedRef.current) return;
      setDiscovery(next);
      const current = selectedIdRef.current;
      if (
        current === null ||
        (next._tag === "ready" && next.instances.some((instance) => instance.id === current))
      ) {
        return;
      }
      selectedIdRef.current = null;
      setSelectedId(null);
      setConnection("revoked");
      void bridge?.deactivate().catch(() => undefined);
    },
    [bridge],
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
        selectedIdRef.current = null;
        setSelectedId(null);
        setConnection("idle");
        setDiscovery({ _tag: "signed_out" });
      })
      .finally(() => {
        if (mountedRef.current) setRefreshing(false);
      });
  }, [bridge]);

  const select = useCallback((instance: CtoxManagedInstance) => {
    if (instance.status !== "available") return;
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
      select,
      setConnection,
    }),
    [
      activationKey,
      bridge,
      connection,
      discovery,
      login,
      logout,
      refresh,
      refreshing,
      select,
      selectedId,
    ],
  );

  return <CtoxModeContext value={value}>{children}</CtoxModeContext>;
}

function statusLabel(instance: CtoxManagedInstance): string {
  const health = instance.healthSummary.dataPlaneReady ? "WebRTC ready" : "WebRTC unavailable";
  return `${instance.status.replaceAll("_", " ")} · ${health}`;
}

export function CtoxManagedInstanceList({
  instances,
}: {
  readonly instances: readonly CtoxManagedInstance[];
}) {
  const { selectedId, connection, select } = useCtoxMode();
  return (
    <div className="space-y-2" aria-label="Managed CTOX instances">
      {instances.map((instance) => {
        const selected = selectedId === instance.id;
        const busy = selected && connection === "connecting";
        const available = instance.status === "available";
        return (
          <button
            key={instance.id}
            type="button"
            className={cn(
              "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
              selected
                ? "border-sidebar-primary/50 bg-sidebar-accent text-sidebar-accent-foreground"
                : "border-sidebar-border/70 bg-sidebar-accent/20 text-sidebar-foreground hover:bg-sidebar-accent/50",
              !available && "cursor-not-allowed opacity-60",
            )}
            aria-pressed={selected}
            aria-busy={busy}
            disabled={!available || busy}
            onClick={() => select(instance)}
          >
            <span className="block text-sm font-medium">{instance.displayName}</span>
            {instance.role !== undefined || instance.domain !== undefined ? (
              <span className="mt-0.5 block text-xs text-sidebar-muted-foreground">
                {[instance.role, instance.domain].filter(Boolean).join(" · ")}
              </span>
            ) : null}
            <span className="mt-1 block text-xs text-sidebar-muted-foreground">
              {statusLabel(instance)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function CtoxSidebarShell() {
  const { discovery, refreshing, refresh, login, logout } = useCtoxMode();
  const readyInstances =
    discovery !== "loading" && discovery._tag === "ready" ? discovery.instances : [];

  return (
    <>
      <SidebarChromeHeader isElectron />
      <SidebarContent className="gap-0" data-ctox-sidebar-shell="">
        <SidebarGroup className="px-[calc(var(--sidebar-content-inset)+0.5rem)] py-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-sidebar-foreground">Managed instances</p>
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

          {discovery === "loading" ? (
            <p className="text-sm text-sidebar-muted-foreground" role="status">
              Loading managed instances…
            </p>
          ) : discovery._tag === "signed_out" ? (
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
          ) : discovery._tag === "failed" ? (
            <p
              className="rounded-lg border border-destructive/30 px-3 py-3 text-sm text-destructive"
              role="alert"
            >
              Managed instance discovery failed. Try refreshing.
            </p>
          ) : readyInstances.length === 0 ? (
            <p
              className="rounded-lg border border-sidebar-border/70 px-3 py-3 text-sm text-sidebar-muted-foreground"
              role="status"
            >
              No managed instances are available.
            </p>
          ) : (
            <>
              <CtoxManagedInstanceList instances={readyInstances} />
              <button
                type="button"
                className="mt-4 text-xs text-sidebar-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
                onClick={logout}
                disabled={refreshing}
              >
                Sign out
              </button>
            </>
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

function ManagedGuestHost({ instance }: { readonly instance: CtoxManagedInstance }) {
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
    if (
      bridge === undefined ||
      bounds === null ||
      selectedId === null ||
      activatedKeyRef.current === activationKey
    ) {
      if (bridge === undefined && connection === "connecting") setConnection("error");
      return;
    }
    activatedKeyRef.current = activationKey;
    let cancelled = false;
    void bridge.activate(selectedId, bounds).then(
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
  }, [activationKey, bounds, bridge, connection, selectedId, setConnection]);

  useEffect(() => {
    if (bridge === undefined || bounds === null || connection !== "ready") return;
    void bridge.setGuestBounds(bounds).catch(() => undefined);
  }, [bounds, bridge, connection]);

  const fallback = {
    connecting: "Connecting to the managed Business OS guest…",
    ready: `Business OS guest for ${instance.displayName} is ready.`,
    error: "The managed Business OS guest could not be opened.",
    revoked: "Access to this managed instance is no longer available.",
    idle: "Select a managed instance to connect.",
  }[connection];

  return (
    <div
      ref={hostRef}
      className="relative min-h-0 flex-1 overflow-hidden bg-background"
      role="region"
      aria-label={`Managed Business OS guest: ${instance.displayName}`}
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
      ? discovery.instances.find((instance) => instance.id === selectedId)
      : undefined;

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
              <EmptyTitle className="text-xl text-foreground">No instance selected</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Select an available managed instance from the sidebar to open Business OS.
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      ) : (
        <ManagedGuestHost instance={selected} />
      )}
    </SidebarInset>
  );
}
