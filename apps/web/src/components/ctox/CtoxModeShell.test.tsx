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
  buildCtoxManualPairingInput,
  canActivateCtoxInstance,
  claimCtoxGuestActivation,
  CTOX_IMPORT_ERROR_MESSAGE,
  CTOX_IMPORT_SUCCESS_MESSAGE,
  CTOX_REMOVE_ERROR_MESSAGE,
  CtoxAppRailList,
  CtoxMainShell,
  CtoxManagedInstanceList,
  CtoxModeProvider,
  CtoxSidebarShell,
  getCtoxManagedState,
  groupCtoxInstances,
  isCurrentCtoxGuestActivation,
  releaseCtoxGuest,
  removeCtoxPairedInstance,
  resolveCtoxGuestBounds,
  retainCtoxGuestBounds,
  submitCtoxInvite,
  submitCtoxManualPairing,
  trackCtoxGuestActivation,
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
    enterBusinessOsMode: async () => ({ _tag: "completed" }),
    exitBusinessOsMode: async () => ({ _tag: "completed" }),
    activate: async () => ({ _tag: "failed", code: "launch_failed" }),
    deactivate: async () => ({ _tag: "completed" }),
    setGuestBounds: async () => ({ _tag: "completed" }),
    listApps: async (instanceId) => ({
      _tag: "completed",
      instanceId,
      source: "cache",
      apps: [],
    }),
    openApp: async () => ({ _tag: "completed" }),
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
    expect(groups.map((group) => group.label)).toEqual(["Managed", "Paired", "Local", "SSH"]);
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

    expect(markup).toContain("Managed");
    expect(markup).toContain("Paired");
    expect(markup).toContain("Local");
    expect(markup).toContain("SSH");
    expect(markup).toContain("ctox.dev · owner · alpha.ctox.dev");
    expect(markup).toContain("Manual pairing · member");
    expect(markup).toContain("Available · WebRTC ready");
    expect(markup).toContain("Paired · WebRTC unavailable");
    expect(markup).not.toContain("room-secret-must-not-render");
    expect(markup).not.toContain("tenant-launch-token-must-not-render");
    expect(markup).not.toContain("partition-must-not-render");
    expect(markup).not.toContain("launch-url-must-not-render");
    expect(markup).not.toContain("httpDataProxy");
  });

  it("renders discovered local daemons as a non-launchable Local group", () => {
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

    expect(canActivateCtoxInstance(local)).toBe(false);
    expect(markup).toContain('id="ctox-local-heading"');
    expect(markup).toContain("Local CTOX instances");
    expect(markup).toContain("Workshop Business OS");
    expect(markup).toContain("Stopped Daemon");
    expect(markup).toContain(
      "Local daemon\nAvailable · WebRTC unavailable\nLocal CTOX daemons cannot be opened yet.",
    );
    expect(markup).toContain(
      "Local daemon\nOffline · WebRTC unavailable\nLocal CTOX daemons cannot be opened yet.",
    );
    // Same flat row style as Managed and Paired, but inert and muted.
    expect(markup).toContain('data-ctox-instance-source="local_daemon"');
    expect(markup).toContain("bg-sidebar-muted-foreground/50");
    expect(markup.match(/data-ctox-instance-source="local_daemon"[^>]*disabled/g)).toHaveLength(2);
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

    expect(markup).toContain("Signed out of ctox.dev");
    expect(markup).toContain("Sign in");
    expect(markup).toContain("Invited Office");
    expect(markup).toContain("Refresh");
    expect(markup).not.toContain("Sign out");
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

    expect(markup).toContain("ctox.dev discovery failed. Paired instances remain available.");
    expect(markup).toContain("Paired Office");
    expect(markup).toContain("Pairing expired · WebRTC unavailable");
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
    const ssh = instance({
      id: "ssh:alpha",
      source: "ssh_managed",
      displayName: "SSH Alpha",
    });

    expect(canActivateCtoxInstance(managed)).toBe(true);
    expect(canActivateCtoxInstance(paired)).toBe(true);
    expect(canActivateCtoxInstance(invited)).toBe(true);
    expect(canActivateCtoxInstance(expired)).toBe(false);
    expect(canActivateCtoxInstance(local)).toBe(false);
    expect(canActivateCtoxInstance(ssh)).toBe(false);

    const markup = renderToStaticMarkup(
      <CtoxModeProvider bridge={inertBridge()} initialDiscovery={{ _tag: "ready", instances: [] }}>
        <CtoxManagedInstanceList instances={[managed, paired, invited, expired, local, ssh]} />
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
      /<button[^>]*disabled=""[^>]*title="[^"]*This pairing is not available\."[^>]*>[^]*Expired Alpha/,
    );
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>[^]*Local Alpha/);
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
        roomSecret: "room-secret",
        capabilityToken: "",
        capabilityExpiresAtMs: "",
        role: "",
        userId: "",
      }),
    ).toEqual({
      displayName: "Office",
      syncRoom: "ctox-business-os:office",
      signalingUrls: ["wss://one.example", "wss://two.example"],
      roomSecret: "room-secret",
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
      roomSecret: secret,
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
  it("renders an honest empty state without a guest surface", () => {
    const markup = renderToStaticMarkup(
      <CtoxModeProvider bridge={inertBridge()} initialDiscovery={{ _tag: "signed_out" }}>
        <CtoxMainShell />
      </CtoxModeProvider>,
    );

    expect(markup).toContain('data-ctox-main-shell=""');
    expect(markup).toContain('data-ctox-main-chrome=""');
    expect(markup).toContain("No instance selected");
    expect(markup).toContain("Select an available instance");
    expect(ctoxModeShellSource).not.toContain("Managed Business OS guest");
    expect(ctoxModeShellSource).not.toContain("managed Business OS guest");
    expect(markup).not.toContain("iframe");
    expect(markup).not.toContain("webview");
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
    expect(markup).toContain("Unpin");
    expect(markup).toContain("Pin");
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
    expect(markup).toContain("This instance is not available.");
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
