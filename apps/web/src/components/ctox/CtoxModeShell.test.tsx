import type {
  CtoxManagedGuestResult,
  CtoxManagedInstance,
  DesktopCtoxBridge,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../sidebar/SidebarChrome", () => ({
  SidebarChromeFooter: () => null,
  SidebarChromeHeader: () => null,
}));

import { SidebarProvider } from "../ui/sidebar";
import ctoxModeShellSource from "./CtoxModeShell.tsx?raw";
import {
  activateCtoxInstance,
  applyCtoxGuestStateEvent,
  buildCtoxManualPairingInput,
  buildCtoxSshManagedInput,
  canActivateCtoxInstance,
  claimCtoxGuestActivation,
  CTOX_IMPORT_ERROR_MESSAGE,
  CTOX_IMPORT_SUCCESS_MESSAGE,
  CTOX_REMOVE_ERROR_MESSAGE,
  CTOX_SSH_LAUNCH_PENDING_HINT,
  CTOX_RAIL_FALLBACK_CATEGORY,
  ctoxInstanceDotClass,
  ctoxInstanceStatusLabel,
  ctoxShellUpdateLabel,
  ctoxRailCollapseKey,
  CtoxAppRailList,
  CtoxMainShell,
  shouldRenderCtoxShellUpdateStatus,
  CtoxManagedInstanceList,
  CtoxModeProvider,
  CtoxSidebarShell,
  getCtoxManagedState,
  groupCtoxInstances,
  groupCtoxRailApps,
  isCurrentCtoxGuestActivation,
  isRemovableCtoxInstance,
  PairingAddSurface,
  releaseCtoxGuest,
  removeCtoxPairedInstance,
  resolveCtoxGuestBounds,
  retainCtoxGuestBounds,
  submitCtoxInvite,
  readCtoxRailCollapsed,
  submitCtoxManualPairing,
  submitCtoxSshManagedInstance,
  suspendCtoxGuestForHostOverlay,
  trackCtoxGuestActivation,
  visibleCtoxRailApps,
  writeCtoxRailCollapsed,
} from "./CtoxModeShell";

const healthy = {
  dataPlane: "rxdb-webrtc" as const,
  dataPlaneReady: true,
  httpDataProxy: false as const,
  nativePeerObserved: true,
};

const unavailable = {
  ...healthy,
  dataPlaneReady: false,
  nativePeerObserved: false,
};

it("shows an authenticated selected backend as synchronized", () => {
  const local = instance({
    id: "local:AAAAAAAAAAAAAAAAAAAAAA",
    source: "local_daemon",
    displayName: "Local Lab",
    healthSummary: unavailable,
  });
  expect(ctoxInstanceStatusLabel(local, false)).toBe(
    "Verfügbar · Synchronisierung nicht verfügbar",
  );
  expect(ctoxInstanceStatusLabel(local, true)).toBe("Verfügbar · Synchronisierung bereit");
});

it("keeps shell freshness visible outside the guest", () => {
  const stale = instance({
    id: "managed:stale",
    source: "ctox_dev",
    displayName: "Welsch",
    shellUpdate: {
      activeVersion: "0.1.9",
      desiredVersion: "0.1.10",
      latestCompatibleVersion: "0.1.10",
      channel: "stable",
      phase: "available",
      health: "healthy",
      administrable: true,
      recoveryShell: false,
      lastCheckedAt: null,
      lastActivatedAt: null,
      errorCode: null,
      pause: null,
    },
  });

  expect(ctoxShellUpdateLabel(stale)).toBe("v0.1.9 · Update auf v0.1.10");
  expect(
    ctoxShellUpdateLabel(
      instance({ id: "managed:unknown", source: "ctox_dev", displayName: "Unknown" }),
    ),
  ).toBe("Shellstatus unbekannt");
});

function instance(
  input: Partial<CtoxManagedInstance> & Pick<CtoxManagedInstance, "id" | "source" | "displayName">,
): CtoxManagedInstance {
  return {
    status: "available",
    healthSummary: healthy,
    ...input,
  };
}

function inertBridge(overrides: Partial<DesktopCtoxBridge> = {}): DesktopCtoxBridge {
  return {
    refresh: async () => ({ _tag: "signed_out" }),
    login: async () => ({ _tag: "cancelled", reason: "closed" }),
    logout: async () => ({ _tag: "completed" }),
    importInvite: async () => ({ _tag: "failed", code: "invalid_invite" }),
    importManualPairing: async () => ({ _tag: "failed", code: "invalid_input" }),
    removePairedInstance: async () => ({ _tag: "completed" }),
    addSshManagedInstance: async () => ({ _tag: "failed", code: "invalid_input" }),
    removeSshManagedInstance: async () => ({ _tag: "completed" }),
    enterBusinessOsMode: async () => ({ _tag: "completed" }),
    exitBusinessOsMode: async () => ({ _tag: "completed" }),
    activate: async () => ({ _tag: "failed", code: "launch_failed" }),
    suspend: async () => ({ _tag: "completed" }),
    deactivate: async () => ({ _tag: "completed" }),
    setGuestBounds: async () => ({ _tag: "completed" }),
    listApps: async (instanceId) => ({
      _tag: "completed",
      instanceId,
      source: "cache",
      apps: [],
    }),
    openApp: async () => ({ _tag: "completed" }),
    openSettings: async () => ({ _tag: "completed" }),
    setAppDocked: async () => ({ _tag: "completed" }),
    setHostTheme: async () => ({ _tag: "completed" }),
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("CTOX instance presentation", () => {
  it("renders deterministic source groups and renderer-safe bounded metadata", () => {
    const bridge = inertBridge();
    const instances = [
      instance({
        id: "paired:manual_pairing:room-secret-must-not-render",
        source: "manual_pairing",
        displayName: "Paired Office",
        status: "paired",
        role: "member",
        healthSummary: unavailable,
      }),
      instance({
        id: "managed:tenant-launch-token-must-not-render",
        source: "ctox_dev",
        displayName: "Managed Alpha",
        domain: "alpha.ctox.dev",
        role: "owner",
      }),
      instance({
        id: "ssh:partition-must-not-render",
        source: "ssh_managed",
        displayName: "SSH Lab",
        status: "offline",
        healthSummary: unavailable,
      }),
      instance({
        id: "local:launch-url-must-not-render",
        source: "local_daemon",
        displayName: "Local Lab",
      }),
    ];

    const groups = groupCtoxInstances(instances);
    expect(groups.map((group) => group.label)).toEqual([
      "CTOX Backend",
      "Verbundene Backends",
      "Lokale Backends",
      "SSH-Backends",
    ]);
    expect(groups.map((group) => group.instances.map(({ displayName }) => displayName))).toEqual([
      ["Managed Alpha"],
      ["Paired Office"],
      ["Local Lab"],
      ["SSH Lab"],
    ]);

    const markup = renderToStaticMarkup(
      <CtoxModeProvider
        bridge={bridge}
        initialDiscovery={{ _tag: "ready", managedState: "ready", instances }}
      >
        <SidebarProvider>
          <CtoxSidebarShell />
        </SidebarProvider>
      </CtoxModeProvider>,
    );

    expect(markup).toContain("CTOX Backend");
    expect(markup).toContain("Verbundene Backends");
    expect(markup).toContain("Lokale Backends");
    expect(markup).toContain("SSH-Backends");
    expect(markup).toContain("CTOX Backend · owner · alpha.ctox.dev");
    expect(markup).toContain("Manuell verbunden · member");
    expect(markup).toContain("Verfügbar · Synchronisierung bereit");
    expect(markup).toContain("Verbunden · Synchronisierung nicht verfügbar");
    expect(markup).not.toContain("room-secret-must-not-render");
    expect(markup).not.toContain("tenant-launch-token-must-not-render");
    expect(markup).not.toContain("partition-must-not-render");
    expect(markup).not.toContain("launch-url-must-not-render");
    expect(markup).not.toContain("httpDataProxy");
  });

  it("renders reachable SSH instances as launchable and unreachable ones as inert", () => {
    const reachable = instance({
      id: "ssh:AAAAAAAAAAAAAAAAAAAAAA",
      source: "ssh_managed",
      displayName: "Build Box",
      healthSummary: unavailable,
    });
    const unreachable = instance({
      id: "ssh:BBBBBBBBBBBBBBBBBBBBBB",
      source: "ssh_managed",
      displayName: "Quiet Box",
      status: "offline",
      healthSummary: unavailable,
    });
    const markup = renderToStaticMarkup(
      <CtoxModeProvider
        bridge={inertBridge()}
        initialDiscovery={{
          _tag: "ready",
          managedState: "ready",
          instances: [reachable, unreachable],
        }}
      >
        <SidebarProvider>
          <CtoxSidebarShell />
        </SidebarProvider>
      </CtoxModeProvider>,
    );

    // A reachable SSH daemon is launchable (invite over SSH + forwarded
    // signaling); an unreachable one is inert with an honest hint.
    expect(canActivateCtoxInstance(reachable)).toBe(true);
    expect(canActivateCtoxInstance(unreachable)).toBe(false);
    expect(isRemovableCtoxInstance(reachable)).toBe(true);
    expect(markup).toContain('id="ctox-ssh-heading"');
    expect(markup).toContain("SSH-Backends");
    expect(markup).toContain("SSH-Backend\nVerfügbar · Synchronisierung nicht verfügbar");
    expect(markup).toContain(CTOX_SSH_LAUNCH_PENDING_HINT);
    // Only the unreachable row is inert; both keep destructive actions out of
    // the primary row and behind a compact context trigger.
    expect(markup.match(/cursor-not-allowed/gu)?.length).toBe(1);
    expect(markup).toContain("Aktionen für Build Box");
    expect(markup).toContain("Aktionen für Quiet Box");
    expect(markup).not.toContain("Build Box entfernen");
  });

  it("offers an SSH tab in the add surface that stores no credential", async () => {
    const addSshManagedInstance = vi.fn(async () => ({
      _tag: "completed" as const,
      instance: {
        id: "ssh:AAAAAAAAAAAAAAAAAAAAAA",
        source: "ssh_managed" as const,
        displayName: "Build Box",
        status: "offline" as const,
        healthSummary: unavailable,
      },
    }));
    const bridge = inertBridge({ addSshManagedInstance });

    expect(
      buildCtoxSshManagedInput({ host: " build-box ", displayName: " ", stateRoot: "" }),
    ).toEqual({ host: "build-box" });
    expect(
      buildCtoxSshManagedInput({
        host: "build-box",
        displayName: "Build Box",
        stateRoot: "/srv/ctox",
      }),
    ).toEqual({ host: "build-box", displayName: "Build Box", stateRoot: "/srv/ctox" });

    const outcome = await submitCtoxSshManagedInstance(bridge, { host: "build-box" });
    expect(outcome.ok).toBe(true);
    expect(addSshManagedInstance).toHaveBeenCalledExactlyOnceWith({ host: "build-box" });

    const markup = renderToStaticMarkup(
      <CtoxModeProvider bridge={bridge} initialDiscovery={{ _tag: "ready", instances: [] }}>
        <SidebarProvider>
          <PairingAddSurface onClose={() => undefined} onImported={() => undefined} />
        </SidebarProvider>
      </CtoxModeProvider>,
    );
    // The add surface offers three peers; SSH sits next to the pairing tabs.
    expect(markup).toContain("grid-cols-3");
    expect(markup).toContain(">Einladung</button>");
    expect(markup).toContain(">Manuell</button>");
    expect(markup).toContain(">SSH</button>");

    // The SSH branch asks only for a destination and an optional state root.
    const sshForm = ctoxModeShellSource.slice(
      ctoxModeShellSource.indexOf('{choice === "ssh" ? ('),
      ctoxModeShellSource.indexOf(') : choice === "invite" ? ('),
    );
    expect(sshForm).toContain("SSH-Host oder Alias");
    expect(sshForm).toContain("CTOX-Datenordner auf diesem Host (optional)");
    expect(sshForm).toContain("Es werden keine Zugangsdaten");
    expect(sshForm).not.toContain('type="password"');
    expect(sshForm).not.toMatch(/secret|token|credential.{0,20}=/iu);
  });

  it("renders running local daemons as launchable and stopped ones as inert", () => {
    const local = instance({
      id: "local:AAAAAAAAAAAAAAAAAAAAAA",
      source: "local_daemon",
      displayName: "Workshop Business OS",
      healthSummary: unavailable,
    });
    const markup = renderToStaticMarkup(
      <CtoxModeProvider
        bridge={inertBridge()}
        initialDiscovery={{
          _tag: "ready",
          managedState: "ready",
          instances: [
            local,
            instance({
              id: "local:BBBBBBBBBBBBBBBBBBBBBB",
              source: "local_daemon",
              displayName: "Stopped Daemon",
              status: "offline",
              healthSummary: unavailable,
            }),
          ],
        }}
      >
        <SidebarProvider>
          <CtoxSidebarShell />
        </SidebarProvider>
      </CtoxModeProvider>,
    );

    expect(canActivateCtoxInstance(local)).toBe(true);
    expect(markup).toContain('id="ctox-local-heading"');
    expect(markup).toContain("Lokale Backends");
    expect(markup).toContain("Workshop Business OS");
    expect(markup).toContain("Stopped Daemon");
    // A running daemon carries no unavailability hint; a stopped one does.
    expect(markup).toContain("Lokales Backend\nVerfügbar · Synchronisierung nicht verfügbar");
    expect(markup).not.toContain(
      "Lokales Backend\nVerfügbar · Synchronisierung nicht verfügbar\nDieses lokale Backend läuft nicht.",
    );
    expect(markup).toContain(
      "Lokales Backend\nOffline · Synchronisierung nicht verfügbar\nDieses lokale Backend läuft nicht.",
    );
    // Same flat row style as Managed and Paired; only the stopped row is inert.
    expect(markup).toContain('data-ctox-instance-source="local_daemon"');
    expect(markup).toContain("bg-sidebar-muted-foreground/50");
    expect(markup.match(/data-ctox-instance-source="local_daemon"[^>]*disabled/g)).toHaveLength(1);
    // A local row offers no Remove control; only paired entries are removable.
    expect(markup).not.toContain("Remove Workshop Business OS");
  });

  it("keeps ctox.dev sign-in available beside paired results", () => {
    const markup = renderToStaticMarkup(
      <CtoxModeProvider
        bridge={inertBridge()}
        initialDiscovery={{
          _tag: "ready",
          managedState: "signed_out",
          instances: [
            instance({
              id: "paired:pairing_invite:stable",
              source: "pairing_invite",
              displayName: "Invited Office",
              status: "paired",
            }),
          ],
        }}
      >
        <SidebarProvider>
          <CtoxSidebarShell />
        </SidebarProvider>
      </CtoxModeProvider>,
    );

    expect(markup).toContain("Nicht bei ctox.dev angemeldet");
    expect(markup).toContain("Anmelden");
    expect(markup).toContain("Invited Office");
    expect(markup).toContain("Settings");
    expect(markup).not.toContain("Abmelden");
  });

  it("renders managed discovery failure without hiding paired results", () => {
    const markup = renderToStaticMarkup(
      <CtoxModeProvider
        bridge={inertBridge()}
        initialDiscovery={{
          _tag: "ready",
          managedState: "failed",
          managedFailureCode: "network_error",
          instances: [
            instance({
              id: "paired:manual_pairing:stable",
              source: "manual_pairing",
              displayName: "Paired Office",
              status: "pairing_expired",
              healthSummary: unavailable,
            }),
          ],
        }}
      >
        <SidebarProvider>
          <CtoxSidebarShell />
        </SidebarProvider>
      </CtoxModeProvider>,
    );

    expect(markup).toContain(
      "CTOX Backend konnte nicht geladen werden. Verbundene Backends bleiben verfügbar.",
    );
    expect(markup).toContain("Paired Office");
    expect(markup).toContain("Verbindung abgelaufen · Synchronisierung nicht verfügbar");
  });

  it("infers legacy managed-only discovery without overriding explicit managed state", () => {
    expect(getCtoxManagedState({ _tag: "ready", instances: [] })).toBe("ready");
    expect(getCtoxManagedState({ _tag: "ready", instances: [], managedState: "signed_out" })).toBe(
      "signed_out",
    );
    expect(getCtoxManagedState({ _tag: "failed", code: "network_error" })).toBe("failed");
  });

  it("enables only available managed and exactly paired invite/manual rows", () => {
    const managed = instance({
      id: "managed:alpha",
      source: "ctox_dev",
      displayName: "Managed Alpha",
    });
    const paired = instance({
      id: "paired:manual_pairing:alpha",
      source: "manual_pairing",
      displayName: "Paired Alpha",
      status: "paired",
    });
    const invited = instance({
      id: "paired:pairing_invite:alpha",
      source: "pairing_invite",
      displayName: "Invited Alpha",
      status: "paired",
    });
    const expired = instance({
      id: "paired:manual_pairing:expired",
      source: "manual_pairing",
      displayName: "Expired Alpha",
      status: "pairing_expired",
    });
    const local = instance({
      id: "local:alpha",
      source: "local_daemon",
      displayName: "Local Alpha",
    });
    const stoppedLocal = instance({
      id: "local:stopped",
      source: "local_daemon",
      displayName: "Stopped Alpha",
      status: "offline",
    });
    const ssh = instance({
      id: "ssh:alpha",
      source: "ssh_managed",
      displayName: "SSH Alpha",
    });

    expect(canActivateCtoxInstance(managed)).toBe(true);
    expect(canActivateCtoxInstance(paired)).toBe(true);
    expect(canActivateCtoxInstance(invited)).toBe(true);
    expect(canActivateCtoxInstance(expired)).toBe(false);
    // A running local daemon launches; a stopped one stays inert.
    expect(canActivateCtoxInstance(local)).toBe(true);
    expect(canActivateCtoxInstance(stoppedLocal)).toBe(false);
    expect(canActivateCtoxInstance({ ...local, status: "error" })).toBe(false);
    // A reachable SSH daemon launches like a local one; offline stays inert.
    expect(canActivateCtoxInstance(ssh)).toBe(true);
    expect(canActivateCtoxInstance({ ...ssh, status: "offline" })).toBe(false);

    const markup = renderToStaticMarkup(
      <CtoxModeProvider bridge={inertBridge()} initialDiscovery={{ _tag: "ready", instances: [] }}>
        <CtoxManagedInstanceList
          instances={[managed, paired, invited, expired, local, stoppedLocal, ssh]}
        />
      </CtoxModeProvider>,
    );

    expect(markup).toMatch(
      /<button(?![^>]*disabled)[^>]*data-ctox-instance-source="ctox_dev"[^>]*data-ctox-instance-status="available"[^>]*>[^]*Managed Alpha/,
    );
    expect(markup).toMatch(
      /<button(?![^>]*disabled)[^>]*data-ctox-instance-source="manual_pairing"[^>]*data-ctox-instance-status="paired"[^>]*>[^]*Paired Alpha/,
    );
    expect(markup).toMatch(
      /<button(?![^>]*disabled)[^>]*data-ctox-instance-source="pairing_invite"[^>]*data-ctox-instance-status="paired"[^>]*>[^]*Invited Alpha/,
    );
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*title="[^"]*Diese Verbindung ist nicht verfügbar\."[^>]*>[^]*Expired Alpha/,
    );
    expect(markup).toMatch(
      /<button(?![^>]*disabled)[^>]*data-ctox-instance-source="local_daemon"[^>]*data-ctox-instance-status="available"[^>]*>[^]*Local Alpha/,
    );
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*title="[^"]*Dieses lokale Backend läuft nicht\."[^>]*>[^]*Stopped Alpha/,
    );
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>[^]*SSH Alpha/);
  });
});

describe("CTOX native guest bounds", () => {
  it("inscribes integer native bounds within the renderer host", () => {
    expect(
      resolveCtoxGuestBounds({ left: 320.2, top: 48.2, right: 1279.8, bottom: 719.8 }),
    ).toEqual({ x: 321, y: 49, width: 958, height: 670 });
    expect(resolveCtoxGuestBounds({ left: -2.4, top: -1.1, right: 0.4, bottom: 0.9 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("retains equal bounds without state identity churn", () => {
    const current = { x: 12, y: 24, width: 800, height: 600 };

    expect(retainCtoxGuestBounds(current, { ...current })).toBe(current);
    expect(retainCtoxGuestBounds(current, { ...current, width: 801 })).toEqual({
      ...current,
      width: 801,
    });
  });

  it("keeps one pending activation observable across a genuine bounds update", async () => {
    const pending = deferred<CtoxManagedGuestResult>();
    const activate = vi.fn(() => pending.promise);
    const activatedKey = { current: 0 };
    const states: string[] = [];
    const bridge = inertBridge();
    const activation = {
      activationKey: 1,
      bridge,
      instanceId: "managed:alpha",
      modeReady: true,
      selectedId: "managed:alpha",
    };
    const currentActivation = activation;
    let bounds = { x: 12, y: 24, width: 800, height: 600 };

    expect(claimCtoxGuestActivation(activatedKey, activation.activationKey)).toBe(true);
    trackCtoxGuestActivation(
      activate(),
      () => isCurrentCtoxGuestActivation(true, currentActivation, activation),
      (state) => states.push(state),
    );

    bounds = retainCtoxGuestBounds(bounds, { ...bounds, width: 960, height: 720 });
    expect(bounds).toEqual({ x: 12, y: 24, width: 960, height: 720 });
    expect(claimCtoxGuestActivation(activatedKey, activation.activationKey)).toBe(false);
    expect(activate).toHaveBeenCalledOnce();

    pending.resolve({ _tag: "ready", instanceId: "managed:alpha" });
    await pending.promise;
    await Promise.resolve();

    expect(states).toEqual(["ready"]);
  });

  it("ignores pending results after unmount or activation identity changes", async () => {
    const bridge = inertBridge();
    const expected = {
      activationKey: 1,
      bridge,
      instanceId: "managed:alpha",
      modeReady: true,
      selectedId: "managed:alpha",
    };

    expect(isCurrentCtoxGuestActivation(false, expected, expected)).toBe(false);
    expect(isCurrentCtoxGuestActivation(true, { ...expected, activationKey: 2 }, expected)).toBe(
      false,
    );
    expect(
      isCurrentCtoxGuestActivation(
        true,
        { ...expected, instanceId: "managed:beta", selectedId: "managed:beta" },
        expected,
      ),
    ).toBe(false);

    const pending = deferred<CtoxManagedGuestResult>();
    const states: string[] = [];
    let current = expected;
    trackCtoxGuestActivation(
      pending.promise,
      () => isCurrentCtoxGuestActivation(true, current, expected),
      (state) => states.push(state),
    );

    current = { ...expected, activationKey: 2 };
    pending.resolve({ _tag: "ready", instanceId: "managed:alpha" });
    await pending.promise;
    await Promise.resolve();

    expect(states).toEqual([]);
  });
});

describe("CTOX bridge actions", () => {
  it("omits empty optional manual-pairing fields and normalizes signaling input", () => {
    expect(
      buildCtoxManualPairingInput({
        displayName: "Office",
        instanceId: "",
        syncRoom: "ctox-business-os:office",
        signalingUrls: "wss://one.example\n wss://two.example,",
        browserToken: "raw-browser-token",
        browserTokenHash: "294dbc745bd2c516e81ae8a8bea452be757f78ae306a24f91c080885bd8bdf97",
        nativeTokenHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        capabilityToken: "",
        capabilityExpiresAtMs: "",
        role: "",
        userId: "",
      }),
    ).toEqual({
      displayName: "Office",
      syncRoom: "ctox-business-os:office",
      signalingUrls: ["wss://one.example", "wss://two.example"],
      signalingAuthVersion: "ctox-role-bound-v1" as const,
      browserToken: "raw-browser-token",
      browserTokenHash: "294dbc745bd2c516e81ae8a8bea452be757f78ae306a24f91c080885bd8bdf97",
      nativeTokenHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("activates paired and managed entries through the existing bridge", async () => {
    const activate = vi.fn(async (instanceId: string) => ({ _tag: "ready" as const, instanceId }));
    const bridge = inertBridge({ activate });
    const bounds = { x: 1, y: 2, width: 300, height: 200 };
    const paired = instance({
      id: "paired:manual_pairing:alpha",
      source: "manual_pairing",
      displayName: "Paired Alpha",
      status: "paired",
    });
    const managed = instance({
      id: "managed:alpha",
      source: "ctox_dev",
      displayName: "Managed Alpha",
    });

    await expect(activateCtoxInstance(bridge, paired, bounds)).resolves.toEqual({
      _tag: "ready",
      instanceId: "paired:manual_pairing:alpha",
    });
    expect(activate).toHaveBeenCalledWith("paired:manual_pairing:alpha", bounds);

    await expect(activateCtoxInstance(bridge, managed, bounds)).resolves.toEqual({
      _tag: "ready",
      instanceId: "managed:alpha",
    });
    expect(activate).toHaveBeenLastCalledWith("managed:alpha", bounds);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("rejects managed removal before calling the paired-instance bridge", async () => {
    const removePairedInstance = vi.fn(async () => ({ _tag: "completed" as const }));
    const bridge = inertBridge({ removePairedInstance });
    const managed = instance({
      id: "managed:alpha",
      source: "ctox_dev",
      displayName: "Managed Alpha",
    });

    await expect(removeCtoxPairedInstance(bridge, managed)).resolves.toEqual({
      ok: false,
      message: CTOX_REMOVE_ERROR_MESSAGE,
    });
    expect(removePairedInstance).not.toHaveBeenCalled();
  });

  it("returns fixed secret-free import copy and forwards inputs without parsing invite secrets", async () => {
    const secret = "room-secret-never-render";
    const signalingUrl = "wss://signal.private.example/secret-path";
    const importInvite = vi.fn(async () => {
      throw new Error(`${secret} ${signalingUrl}`);
    });
    const failed = await submitCtoxInvite(inertBridge({ importInvite }), secret);

    expect(importInvite).toHaveBeenCalledExactlyOnceWith(secret);
    expect(failed).toEqual({ ok: false, message: CTOX_IMPORT_ERROR_MESSAGE });
    expect(failed.message).not.toContain(secret);
    expect(failed.message).not.toContain(signalingUrl);

    const manualInput = {
      displayName: "Office",
      syncRoom: "ctox-business-os:office",
      signalingUrls: [signalingUrl],
      signalingAuthVersion: "ctox-role-bound-v1" as const,
      browserToken: secret,
      browserTokenHash: "294dbc745bd2c516e81ae8a8bea452be757f78ae306a24f91c080885bd8bdf97",
      nativeTokenHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const importManualPairing = vi.fn(async () => ({
      _tag: "completed" as const,
      instance: instance({
        id: "paired:manual_pairing:office",
        source: "manual_pairing",
        displayName: "Office",
        status: "paired",
      }),
    }));
    const completed = await submitCtoxManualPairing(
      inertBridge({ importManualPairing }),
      manualInput,
    );

    expect(importManualPairing).toHaveBeenCalledExactlyOnceWith(manualInput);
    expect(completed).toEqual({ ok: true, message: CTOX_IMPORT_SUCCESS_MESSAGE });
    expect(completed.message).not.toContain(secret);
    expect(completed.message).not.toContain(signalingUrl);
  });

  it("uses the desktop bridge cleanup for CTOX mode unmount", async () => {
    const deactivate = vi.fn(async () => ({ _tag: "completed" as const }));
    releaseCtoxGuest(inertBridge({ deactivate }));
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledOnce());
  });
});

describe("CtoxMainShell", () => {
  it("keeps exactly one Workjet header above the active Business OS guest", () => {
    expect(ctoxModeShellSource).not.toContain("const chromeHidden");
    expect(ctoxModeShellSource).toContain('data-ctox-main-chrome=""');
    expect(ctoxModeShellSource.indexOf('data-ctox-main-chrome=""')).toBe(
      ctoxModeShellSource.lastIndexOf('data-ctox-main-chrome=""'),
    );
    expect(ctoxModeShellSource).toContain("<CtoxGuestHost instance={selected} />");
    expect(ctoxModeShellSource).toContain("CtoxShellUpdateButton");
    expect(ctoxModeShellSource).toContain("shouldRenderCtoxShellUpdateStatus");
    expect(ctoxModeShellSource).toContain("selected === undefined ? (");
    expect(ctoxModeShellSource).not.toContain("BusinessOsSettingsDialog");
    expect(ctoxModeShellSource).not.toContain("openSettingsRequestKey");
  });

  it("omits only an unavailable mobile shell status without inventing a value", () => {
    const withoutUpdate = instance({
      id: "managed:mobile-without-update",
      source: "ctox_dev",
      displayName: "Mobile",
    });
    const withUpdate = instance({
      id: "managed:mobile-with-update",
      source: "ctox_dev",
      displayName: "Mobile",
      shellUpdate: {
        activeVersion: "0.1.11",
        desiredVersion: "0.1.11",
        latestCompatibleVersion: "0.1.11",
        channel: "stable",
        phase: "current",
        health: "healthy",
        administrable: true,
        recoveryShell: false,
        lastCheckedAt: null,
        lastActivatedAt: null,
        errorCode: null,
        pause: null,
      },
    });

    expect(shouldRenderCtoxShellUpdateStatus(withoutUpdate, true)).toBe(false);
    expect(shouldRenderCtoxShellUpdateStatus(withoutUpdate, false)).toBe(true);
    expect(shouldRenderCtoxShellUpdateStatus(withUpdate, true)).toBe(true);
  });

  it("detaches the native guest before a host-owned overlay is revealed", async () => {
    const suspend = vi.fn(async () => ({ _tag: "completed" as const }));

    await expect(suspendCtoxGuestForHostOverlay(inertBridge({ suspend }))).resolves.toBe(true);
    expect(suspend).toHaveBeenCalledOnce();

    await expect(
      suspendCtoxGuestForHostOverlay(
        inertBridge({ suspend: async () => ({ _tag: "failed", code: "guest_failed" }) }),
      ),
    ).resolves.toBe(false);
  });

  it("renders an honest empty state without a guest surface", () => {
    const markup = renderToStaticMarkup(
      <CtoxModeProvider bridge={inertBridge()} initialDiscovery={{ _tag: "signed_out" }}>
        <CtoxMainShell />
      </CtoxModeProvider>,
    );

    expect(markup).toContain('data-ctox-main-shell=""');
    expect(markup).toContain('data-ctox-main-chrome=""');
    expect(markup).toContain("Kein Backend ausgewählt");
    expect(markup).toContain("Wählen Sie ein verfügbares Backend");
    expect(ctoxModeShellSource).not.toContain("Managed Business OS guest");
    expect(ctoxModeShellSource).not.toContain("managed Business OS guest");
    expect(markup).not.toContain("iframe");
    expect(markup).not.toContain("webview");
  });

  it("keeps exposed host copy in product language", () => {
    const markup = renderToStaticMarkup(
      <CtoxModeProvider
        bridge={inertBridge()}
        initialDiscovery={{
          _tag: "ready",
          managedState: "ready",
          instances: [
            instance({
              id: "paired:manual_pairing:copy",
              source: "manual_pairing",
              displayName: "Copy Office",
              status: "paired",
              healthSummary: unavailable,
            }),
          ],
        }}
      >
        <SidebarProvider>
          <CtoxSidebarShell />
        </SidebarProvider>
      </CtoxModeProvider>,
    );
    const textAndExposedAttributes = [
      markup.replace(/<[^>]*>/gu, " "),
      ...[...markup.matchAll(/(?:aria-label|title)="([^"]*)"/gu)].map((match) => match[1]),
    ].join(" ");

    expect(textAndExposedAttributes).not.toMatch(
      /\b(?:guest|webcontentsview|sidecar|native|binary|room|signaling|rxdb|webrtc)\b/iu,
    );
    expect(markup).toContain("CTOX Backend");
    expect(markup).toContain("Verbundene Backends");
    expect(ctoxModeShellSource).toContain("aria-label={`Business OS: ${instance.displayName}`}");
    expect(ctoxModeShellSource).toContain('error: "Business OS konnte nicht geöffnet werden."');
    for (const staleCopy of [
      "Business OS guest",
      "WebRTC ready",
      "WebRTC unavailable",
      "Signaling URLs",
      "Room secret",
      "Sync room",
      "Manual pairing",
      "Add instance",
    ]) {
      expect(ctoxModeShellSource).not.toContain(staleCopy);
    }
  });

  it("introduces no iframe, webview, or alternate HTTP data surface", () => {
    expect(ctoxModeShellSource).not.toMatch(/<iframe\b/iu);
    expect(ctoxModeShellSource).not.toMatch(/<webview\b/iu);
    expect(ctoxModeShellSource).not.toMatch(/\bfetch\s*\(/u);
    expect(ctoxModeShellSource).not.toMatch(/\bXMLHttpRequest\b/u);
    expect(ctoxModeShellSource).not.toMatch(/\baxios\b/u);
  });
});

describe("CTOX app rail presentation", () => {
  const railInstance = instance({
    id: "paired:manual_pairing:rail",
    source: "manual_pairing",
    displayName: "Rail Office",
    status: "paired",
    healthSummary: unavailable,
  });
  const railApps = [
    { id: "crm", title: "CRM", docked: true, open: false, lastSeenAt: 1 },
    { id: "ledger", title: "Ledger", docked: true, open: true, lastSeenAt: 2 },
    { id: "notes", title: "Notes", docked: false, open: true, lastSeenAt: 3 },
  ] as const;

  it("distinguishes docked, open, and undocked-open app rows", () => {
    const markup = renderToStaticMarkup(
      <CtoxAppRailList
        instance={railInstance}
        apps={railApps}
        instanceReady={true}
        source="live"
        launchable={true}
        onOpen={() => undefined}
        onToggleDock={() => undefined}
      />,
    );
    expect(markup).toContain('data-ctox-app-id="crm"');
    expect(markup).toContain('data-ctox-app-docked="true"');
    expect(markup).toContain('data-ctox-app-docked="false"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("CRM");
    expect(markup).toContain("Lösen");
    expect(markup).toContain("Anheften");
  });

  it("greys the rail and closes open markers while the instance is disconnected", () => {
    const markup = renderToStaticMarkup(
      <CtoxAppRailList
        instance={railInstance}
        apps={railApps}
        instanceReady={false}
        source="cache"
        launchable={false}
        onOpen={() => undefined}
        onToggleDock={() => undefined}
      />,
    );
    expect(markup).not.toContain('aria-current="true"');
    expect(markup).toContain("cursor-not-allowed");
    expect(markup).toContain("Dieses Backend ist nicht verfügbar.");
  });

  it("renders nothing for an instance without rail apps", () => {
    const markup = renderToStaticMarkup(
      <CtoxAppRailList
        instance={railInstance}
        apps={[]}
        instanceReady={false}
        source="cache"
        launchable={true}
        onOpen={() => undefined}
        onToggleDock={() => undefined}
      />,
    );
    expect(markup).toBe("");
  });

  it("falls back to the module id when an app has no title", () => {
    const markup = renderToStaticMarkup(
      <CtoxAppRailList
        instance={railInstance}
        apps={[{ id: "warehouse", docked: true, open: false }]}
        instanceReady={true}
        source="live"
        launchable={true}
        onOpen={() => undefined}
        onToggleDock={() => undefined}
      />,
    );
    expect(markup).toContain("warehouse");
  });
});

describe("CTOX app rail categories", () => {
  const railInstance = instance({
    id: "paired:manual_pairing:rail",
    source: "manual_pairing",
    displayName: "Rail Office",
    status: "paired",
    healthSummary: unavailable,
  });

  function app(
    id: string,
    input: { title?: string; category?: string; docked?: boolean; open?: boolean } = {},
  ) {
    return {
      id,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.category === undefined ? {} : { category: input.category }),
      docked: input.docked ?? false,
      open: input.open ?? false,
    };
  }

  function memoryStorage(seed: Record<string, string> = {}): Storage {
    const map = new Map(Object.entries(seed));
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null,
      removeItem: (key: string) => void map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, value),
    } as Storage;
  }

  function withWindowStorage<A>(storage: Storage, body: () => A): A {
    const holder = globalThis as unknown as { window?: unknown };
    const previous = holder.window;
    holder.window = { localStorage: storage };
    try {
      return body();
    } finally {
      if (previous === undefined) delete holder.window;
      else holder.window = previous;
    }
  }

  it("keeps docked apps ungrouped on top and orders categories by open state", () => {
    const { docked, categories } = groupCtoxRailApps([
      app("pinned-b", { title: "Pinned B", category: "Workspace", docked: true }),
      app("pinned-a", { title: "Pinned A", category: "Zulu", docked: true }),
      app("mail", { title: "Mail", category: "Workspace" }),
      app("audit", { title: "Audit", category: "Zulu", open: true }),
      app("alpha", { title: "Alpha", category: "Zulu" }),
      app("loose", { title: "Loose" }),
    ]);
    // Docked apps keep their incoming pin order and are never bucketed.
    expect(docked.map((entry) => entry.id)).toEqual(["pinned-b", "pinned-a"]);
    expect(categories.map((group) => group.category)).toEqual([
      "Zulu",
      CTOX_RAIL_FALLBACK_CATEGORY,
      "Workspace",
    ]);
    expect(categories[0]?.apps.map((entry) => entry.id)).toEqual(["audit", "alpha"]);
    expect(categories[1]?.apps.map((entry) => entry.id)).toEqual(["loose"]);
  });

  it("never hides an open app behind the show-more row", () => {
    const apps = [
      ...Array.from({ length: 7 }, (_, index) => app(`open-${index}`, { open: true })),
      ...Array.from({ length: 4 }, (_, index) => app(`idle-${index}`)),
    ];
    const [group] = groupCtoxRailApps(apps).categories;
    const preview = visibleCtoxRailApps(group!.apps, false);
    expect(preview).toHaveLength(7);
    expect(preview.every((entry) => entry.open)).toBe(true);
    expect(visibleCtoxRailApps(group!.apps, true)).toHaveLength(11);
  });

  it("caps a quiet category at five apps and offers the remainder", () => {
    const apps = Array.from({ length: 8 }, (_, index) => app(`app-${index}`));
    const [group] = groupCtoxRailApps(apps).categories;
    expect(visibleCtoxRailApps(group!.apps, false)).toHaveLength(5);
  });

  it("renders category headers with a show-more row for the hidden remainder", () => {
    const markup = renderToStaticMarkup(
      <CtoxAppRailList
        instance={railInstance}
        apps={[
          app("pinned", { title: "Pinned", category: "Workspace", docked: true }),
          ...Array.from({ length: 8 }, (_, index) =>
            app(`ops-${index}`, {
              title: `Ops ${index}`,
              category: "Operations",
              open: index === 0,
            }),
          ),
        ]}
        instanceReady={true}
        source="live"
        launchable={true}
        onOpen={() => undefined}
        onToggleDock={() => undefined}
      />,
    );
    expect(markup).toContain('data-ctox-app-category="Operations"');
    expect(markup).toContain('data-ctox-app-category-collapsed="false"');
    expect(markup).toContain("Mehr anzeigen (3)");
    expect(markup).not.toContain("Weniger anzeigen");
    // The docked app stays out of every category bucket.
    expect(markup).not.toContain('data-ctox-app-category="Workspace"');
    expect(markup).toContain('data-ctox-app-id="pinned"');
    expect(markup).toContain('data-ctox-app-id="ops-4"');
    expect(markup).not.toContain('data-ctox-app-id="ops-7"');
  });

  it("omits the show-more row when a category fits in the preview", () => {
    const markup = renderToStaticMarkup(
      <CtoxAppRailList
        instance={railInstance}
        apps={[app("mail", { title: "Mail", category: "Workspace" })]}
        instanceReady={true}
        source="live"
        launchable={true}
        onOpen={() => undefined}
        onToggleDock={() => undefined}
      />,
    );
    expect(markup).not.toContain("Mehr anzeigen");
  });

  it("persists collapse state per instance and category", () => {
    const storage = memoryStorage();
    expect(ctoxRailCollapseKey(railInstance.id, "Operations")).toBe(
      `ctox.rail.collapsed:${railInstance.id}:Operations`,
    );
    expect(readCtoxRailCollapsed(railInstance.id, "Operations", storage)).toBe(false);
    writeCtoxRailCollapsed(railInstance.id, "Operations", true, storage);
    expect(readCtoxRailCollapsed(railInstance.id, "Operations", storage)).toBe(true);
    // A sibling category of the same instance is unaffected.
    expect(readCtoxRailCollapsed(railInstance.id, "Workspace", storage)).toBe(false);
    expect(readCtoxRailCollapsed("other-instance", "Operations", storage)).toBe(false);
    writeCtoxRailCollapsed(railInstance.id, "Operations", false, storage);
    expect(readCtoxRailCollapsed(railInstance.id, "Operations", storage)).toBe(false);
    // Blocked or absent storage stays silently expanded.
    expect(readCtoxRailCollapsed(railInstance.id, "Operations", undefined)).toBe(false);
    expect(() =>
      writeCtoxRailCollapsed(railInstance.id, "Operations", true, undefined),
    ).not.toThrow();
  });

  it("renders a persisted collapsed category without its app rows", () => {
    const storage = memoryStorage({
      [ctoxRailCollapseKey(railInstance.id, "Operations")]: "1",
      [ctoxRailCollapseKey(railInstance.id, "Workspace")]: "0",
    });
    const markup = withWindowStorage(storage, () =>
      renderToStaticMarkup(
        <CtoxAppRailList
          instance={railInstance}
          apps={[
            app("tickets", { title: "Tickets", category: "Operations" }),
            app("mail", { title: "Mail", category: "Workspace" }),
          ]}
          instanceReady={true}
          source="live"
          launchable={true}
          onOpen={() => undefined}
          onToggleDock={() => undefined}
        />,
      ),
    );
    expect(markup).toContain('data-ctox-app-category="Operations"');
    expect(markup).toContain('data-ctox-app-category-collapsed="true"');
    expect(markup).not.toContain('data-ctox-app-id="tickets"');
    // A stored expansion remains explicit even though quiet categories now
    // default to collapsed.
    expect(markup).toContain('data-ctox-app-id="mail"');
  });
});

describe("CTOX guest lifecycle presentation", () => {
  const managed = instance({
    id: "managed:alpha",
    source: "ctox_dev",
    displayName: "Managed Alpha",
  });

  it("folds guest-state events into a minimal per-instance map", () => {
    const empty = new Map<string, "none" | "loading" | "warm">();
    const loading = applyCtoxGuestStateEvent(empty, {
      instanceId: "managed:alpha",
      state: "loading",
    });
    expect(loading.get("managed:alpha")).toBe("loading");
    const warm = applyCtoxGuestStateEvent(loading, {
      instanceId: "managed:alpha",
      state: "warm",
    });
    expect(warm.get("managed:alpha")).toBe("warm");
    // An unchanged state keeps the map identity so no re-render is forced.
    expect(applyCtoxGuestStateEvent(warm, { instanceId: "managed:alpha", state: "warm" })).toBe(
      warm,
    );
    // "none" removes the entry entirely: absence IS the none state.
    const cleared = applyCtoxGuestStateEvent(warm, {
      instanceId: "managed:alpha",
      state: "none",
    });
    expect(cleared.has("managed:alpha")).toBe(false);
    expect(cleared.size).toBe(0);
    expect(applyCtoxGuestStateEvent(cleared, { instanceId: "managed:alpha", state: "none" })).toBe(
      cleared,
    );
  });

  it("colors the sidebar dot from the guest lifecycle before the discovery status", () => {
    // A warm guest switches instantly and shows the same green as connected.
    expect(ctoxInstanceDotClass(managed, false, "warm")).toBe("bg-emerald-500");
    expect(ctoxInstanceDotClass(managed, true, "none")).toBe("bg-emerald-500");
    // A first load pulses amber; only a guest-less instance falls back to the
    // discovery status coloring.
    expect(ctoxInstanceDotClass(managed, false, "loading")).toContain("animate-pulse");
    expect(ctoxInstanceDotClass(managed, false, "none")).toBe("bg-sidebar-muted-foreground/50");
    expect(ctoxInstanceDotClass(managed, false)).toBe("bg-sidebar-muted-foreground/50");
    expect(ctoxInstanceDotClass({ ...managed, status: "offline" }, false, "none")).toBe(
      "bg-red-500/80",
    );
    expect(ctoxInstanceDotClass({ ...managed, status: "needs_auth" }, false, "none")).toBe(
      "bg-amber-500/90",
    );
  });

  it("renders the guest state on the instance row without leaking identity", () => {
    const markup = renderToStaticMarkup(
      <CtoxModeProvider
        bridge={inertBridge()}
        initialDiscovery={{ _tag: "ready", managedState: "ready", instances: [managed] }}
      >
        <SidebarProvider>
          <CtoxSidebarShell />
        </SidebarProvider>
      </CtoxModeProvider>,
    );
    expect(markup).toContain('data-ctox-guest-state="none"');
    expect(markup).toContain("bg-sidebar-muted-foreground/50");
  });
});

describe("CTOX instance collapse", () => {
  const managed = instance({
    id: "managed:alpha",
    source: "ctox_dev",
    displayName: "Managed Alpha",
  });

  it("keeps unselected trees compact with a chevron affordance separate from selection", () => {
    const markup = renderToStaticMarkup(
      <CtoxModeProvider
        bridge={inertBridge()}
        initialDiscovery={{ _tag: "ready", managedState: "ready", instances: [managed] }}
      >
        <SidebarProvider>
          <CtoxManagedInstanceList instances={[managed]} />
        </SidebarProvider>
      </CtoxModeProvider>,
    );
    // A non-selected backend starts folded so several catalogs cannot flood
    // the sidebar at once.
    expect(markup).toContain('data-ctox-instance-collapsed="true"');
    expect(markup).toContain("Apps einblenden: Managed Alpha");
    expect(markup).not.toContain("rotate-90");
    // The chevron is its own button, so folding never triggers selection; the
    // name click both selects and re-expands (see the row's onClick).
    expect(ctoxModeShellSource).toContain("setCollapsed((value) => !value)");
    expect(ctoxModeShellSource).toContain("setCollapsed(false);\n            select(instance);");
    // Selection opens the current tree and closes the previously selected one.
    expect(ctoxModeShellSource).toContain("setCollapsed(!selected);");
  });
});

describe("CTOX sidebar footer", () => {
  it("offers exactly one labelled Settings entry and no shortcut strip", () => {
    const markup = renderToStaticMarkup(
      <CtoxModeProvider bridge={inertBridge()} initialDiscovery={{ _tag: "signed_out" }}>
        <SidebarProvider>
          <CtoxSidebarShell />
        </SidebarProvider>
      </CtoxModeProvider>,
    );
    expect(markup).toContain('data-ctox-sidebar-footer=""');
    expect(markup).toContain("Settings");
    expect(markup).not.toContain("Business OS-Einstellungen");
    expect(markup).not.toContain('aria-label="Backends aktualisieren"');
    expect(markup).not.toContain("Check for updates");
    expect(markup).not.toContain("Provider update");
    expect(ctoxModeShellSource).toContain('navigate({ to: "/settings/business-os" })');
    // Code-mode footer entries whose pages the Business OS surface never
    // renders would be dead icons here and must not appear.
    expect(markup).not.toContain('aria-label="Usage"');
    expect(markup).not.toContain('aria-label="Machines"');
    expect(markup).not.toContain('aria-label="Pull Requests"');
  });
});
